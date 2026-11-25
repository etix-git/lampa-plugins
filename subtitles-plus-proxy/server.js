#!/usr/bin/env node
/**
 * Subtitles Plus proxy for Lampa on webOS
 *
 * A pass-through ("tee") HTTP proxy for the torrent video stream. The player reads the video through
 * http://127.0.0.1:8095/v/<name>?u=<TorrServer stream URL>; the proxy forwards every request to
 * TorrServer as is and, on the way, picks the text subtitle blocks out of the Matroska stream.
 * The plugin "Subtitles: Plus" then asks for the subtitle lines and draws them itself.
 *
 * No extra traffic: only the bytes the player downloads anyway are parsed. Video and audio blocks are
 * skipped without buffering; only text subtitle blocks (a few hundred bytes each) are kept.
 *
 * Endpoints (CORS *):
 *   GET  /health                               {ok, version, sessions}
 *   GET  /v/<name>?u=<url>, HEAD the same      the video, Range supported
 *   GET  /tracks?u=<url>                       subtitle tracks of the stream
 *   GET  /subs?u=<url>&track=N&from=S&to=S     subtitle lines in the window, in seconds
 *
 * Node 12+, no dependencies. Port and host: SUBSPLUS_PORT (8095), SUBSPLUS_HOST (127.0.0.1).
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');

const VERSION = '1.0.0';
const PORT = parseInt(process.env.SUBSPLUS_PORT || '8095', 10);
const HOST = process.env.SUBSPLUS_HOST || '127.0.0.1';

const SESSION_IDLE = 30 * 60 * 1000;
const MAX_CUES = 20000;
const MAX_TEXT_BLOCK = 1024 * 1024;
const MAX_HEADER_ELEMENT = 16 * 1024 * 1024;
const DEFAULT_CUE_DURATION = 4;

/* ------------------------------------------------------------------ */
/* Matroska                                                            */
/* ------------------------------------------------------------------ */

const ID = {
    EBML: 0x1A45DFA3,
    SEGMENT: 0x18538067,
    SEEKHEAD: 0x114D9B74,
    INFO: 0x1549A966,
    TIMESTAMP_SCALE: 0x2AD7B1,
    DURATION: 0x4489,
    TRACKS: 0x1654AE6B,
    TRACK_ENTRY: 0xAE,
    TRACK_NUMBER: 0xD7,
    TRACK_TYPE: 0x83,
    CODEC_ID: 0x86,
    CODEC_PRIVATE: 0x63A2,
    LANGUAGE: 0x22B59C,
    LANGUAGE_BCP47: 0x22B59D,
    NAME: 0x536E,
    FLAG_DEFAULT: 0x88,
    FLAG_FORCED: 0x55AA,
    CONTENT_ENCODINGS: 0x6D80,
    CONTENT_ENCODING: 0x6240,
    CONTENT_ENCODING_SCOPE: 0x5032,
    CONTENT_ENCODING_TYPE: 0x5033,
    CONTENT_COMPRESSION: 0x5034,
    CONTENT_COMP_ALGO: 0x4254,
    CONTENT_COMP_SETTINGS: 0x4255,
    CLUSTER: 0x1F43B675,
    TIMESTAMP: 0xE7,
    SIMPLE_BLOCK: 0xA3,
    BLOCK_GROUP: 0xA0,
    BLOCK: 0xA1,
    BLOCK_DURATION: 0x9B,
    CUES: 0x1C53BB6B,
    CHAPTERS: 0x1043A770,
    TAGS: 0x1254C367,
    ATTACHMENTS: 0x1941A469,
    CRC32: 0xBF,
    VOID: 0xEC
};

// children of Segment: when one of them shows up, a Cluster of unknown size is over
const LEVEL1 = new Set([ID.SEEKHEAD, ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, ID.CHAPTERS, ID.TAGS, ID.ATTACHMENTS]);

const TEXT_CODECS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT', 'S_TEXT/ASCII']);
const TRACK_TYPE_SUBTITLE = 0x11;

function leadingZeros(byte) {
    let n = 0;

    for (let mask = 0x80; mask && !(byte & mask); mask >>= 1) n++;

    return n;
}

/**
 * Element header from the first n bytes of buf
 * @returns {{id:number, size:number, len:number}|null|false} null: need more bytes, false: not a header
 */
function parseHeader(buf, n) {
    if (n < 1) return null;

    const first = buf[0];
    const idLen = leadingZeros(first) + 1;

    if (first === 0 || idLen > 4) return false;
    if (n < idLen + 1) return null;

    let id = 0;

    for (let i = 0; i < idLen; i++) id = id * 256 + buf[i];

    const s0 = buf[idLen];
    const sizeLen = leadingZeros(s0) + 1;

    if (s0 === 0 || sizeLen > 8) return false;
    if (n < idLen + sizeLen) return null;

    const mask = 0xFF >> sizeLen;
    let size = s0 & mask;
    let unknown = size === mask;

    for (let i = 1; i < sizeLen; i++) {
        const b = buf[idLen + i];

        size = size * 256 + b;
        unknown = unknown && b === 0xFF;
    }

    return { id, size: unknown ? -1 : size, len: idLen + sizeLen };
}

function readUint(buf) {
    let v = 0;

    for (let i = 0; i < buf.length; i++) v = v * 256 + buf[i];

    return v;
}

function readFloat(buf) {
    if (buf.length === 4) return buf.readFloatBE(0);
    if (buf.length === 8) return buf.readDoubleBE(0);

    return 0;
}

function readString(buf) {
    return buf.toString('utf8').replace(/\0+$/, '');
}

/** Children of a fully buffered element: [{id, data}] */
function children(buf) {
    const out = [];
    let pos = 0;

    while (pos < buf.length) {
        const h = parseHeader(buf.slice(pos, pos + 12), Math.min(12, buf.length - pos));

        if (!h || h.size < 0) break;

        const start = pos + h.len;
        const end = Math.min(buf.length, start + h.size);

        out.push({ id: h.id, data: buf.slice(start, end) });
        pos = end;
    }

    return out;
}

function parseEncoding(buf) {
    let encoding = null;

    children(buf).forEach((enc) => {
        if (enc.id !== ID.CONTENT_ENCODING) return;

        let type = 0;
        let scope = 1;
        let algo = 0;
        let settings = null;
        let compression = false;

        children(enc.data).forEach((c) => {
            if (c.id === ID.CONTENT_ENCODING_TYPE) type = readUint(c.data);
            if (c.id === ID.CONTENT_ENCODING_SCOPE) scope = readUint(c.data);
            if (c.id === ID.CONTENT_COMPRESSION) {
                compression = true;

                children(c.data).forEach((cc) => {
                    if (cc.id === ID.CONTENT_COMP_ALGO) algo = readUint(cc.data);
                    if (cc.id === ID.CONTENT_COMP_SETTINGS) settings = cc.data;
                });
            }
        });

        if (type === 0 && compression && (scope & 1)) encoding = { algo, settings };
        else if (type !== 0) encoding = { algo: -1, settings: null }; // encrypted: cannot read
    });

    return encoding;
}

function parseTracks(buf) {
    const tracks = [];

    children(buf).forEach((entry) => {
        if (entry.id !== ID.TRACK_ENTRY) return;

        const t = { number: 0, type: 0, codec: '', lang: 'eng', name: '', isDefault: true, forced: false, encoding: null };

        children(entry.data).forEach((c) => {
            if (c.id === ID.TRACK_NUMBER) t.number = readUint(c.data);
            else if (c.id === ID.TRACK_TYPE) t.type = readUint(c.data);
            else if (c.id === ID.CODEC_ID) t.codec = readString(c.data);
            else if (c.id === ID.LANGUAGE) t.lang = readString(c.data);
            else if (c.id === ID.LANGUAGE_BCP47) t.bcp47 = readString(c.data);
            else if (c.id === ID.NAME) t.name = readString(c.data);
            else if (c.id === ID.FLAG_DEFAULT) t.isDefault = readUint(c.data) === 1;
            else if (c.id === ID.FLAG_FORCED) t.forced = readUint(c.data) === 1;
            else if (c.id === ID.CONTENT_ENCODINGS) t.encoding = parseEncoding(c.data);
        });

        if (t.bcp47) t.lang = t.bcp47;

        tracks.push(t);
    });

    return tracks;
}

function parseInfo(buf) {
    const info = { scale: 1000000, duration: 0 };
    let duration = 0;

    children(buf).forEach((c) => {
        if (c.id === ID.TIMESTAMP_SCALE) info.scale = readUint(c.data) || 1000000;
        if (c.id === ID.DURATION) duration = readFloat(c.data);
    });

    info.duration = duration * info.scale / 1e9;

    return info;
}

/** Text of a subtitle block, or null */
function blockText(track, payload) {
    let data = payload;
    const enc = track.encoding;

    if (enc) {
        if (enc.algo === 0) {
            try {
                data = zlib.inflateSync(data);
            } catch (e) {
                return null;
            }
        } else if (enc.algo === 3) {
            data = Buffer.concat([enc.settings || Buffer.alloc(0), data]);
        } else {
            return null;
        }
    }

    let text = data.toString('utf8').replace(/\0+$/, '');

    if (track.codec === 'S_TEXT/ASS' || track.codec === 'S_TEXT/SSA') {
        // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
        const parts = text.split(',');

        if (parts.length < 9) return null;

        return { text: parts.slice(8).join(',').trim(), style: parts[2].trim() };
    }

    return { text: text.trim(), style: '' };
}

/* ------------------------------------------------------------------ */
/* Session: one stream, shared by all connections of the player        */
/* ------------------------------------------------------------------ */

class Session {
    constructor(key) {
        this.key = key;
        this.scale = 1000000;
        this.duration = 0;
        this.tracks = null;   // all tracks; null until Tracks is read
        this.cues = new Map();  // track number -> [{start, end, text, style}]
        this.readTime = 0;    // time of the cluster read last
        this.touched = Date.now();
        this.walkers = 0;
    }

    setInfo(buf) {
        const info = parseInfo(buf);

        this.scale = info.scale;
        this.duration = info.duration;
    }

    setTracks(buf) {
        this.tracks = parseTracks(buf);

        let order = 0;

        this.tracks.forEach((t) => {
            t.subtitle = t.type === TRACK_TYPE_SUBTITLE;
            t.text = t.subtitle && TEXT_CODECS.has(t.codec) && !(t.encoding && t.encoding.algo === -1);
            t.order = t.subtitle ? order++ : -1;
        });

        log('tracks', this.key, this.tracks.filter((t) => t.subtitle).map((t) => t.number + ':' + t.codec + ':' + t.lang).join(' '));
    }

    track(number) {
        if (!this.tracks) return null;

        for (const t of this.tracks) {
            if (t.number === number) return t;
        }

        return null;
    }

    addCue(number, start, end, text, style) {
        let list = this.cues.get(number);

        if (!list) this.cues.set(number, list = []);

        // binary search of the insert position by start
        let lo = 0;
        let hi = list.length;

        while (lo < hi) {
            const mid = (lo + hi) >> 1;

            if (list[mid].start < start) lo = mid + 1;
            else hi = mid;
        }

        for (let i = Math.max(0, lo - 1); i < Math.min(list.length, lo + 2); i++) {
            if (Math.abs(list[i].start - start) < 0.002 && list[i].text === text) return;
        }

        list.splice(lo, 0, { start, end, text, style });

        if (list.length > MAX_CUES) list.shift();
    }

    window(number, from, to) {
        const list = this.cues.get(number) || [];
        const out = [];

        for (const c of list) {
            if (c.start >= to) break;
            if (c.end > from) out.push(c);
        }

        return out;
    }

    info() {
        return {
            ready: !!this.tracks,
            duration: this.duration,
            readTime: this.readTime,
            tracks: (this.tracks || []).filter((t) => t.subtitle).map((t) => ({
                number: t.number,
                order: t.order,
                codec: t.codec,
                lang: t.lang,
                name: t.name,
                isDefault: t.isDefault,
                forced: t.forced,
                text: t.text,
                cues: (this.cues.get(t.number) || []).length
            }))
        };
    }
}

/* ------------------------------------------------------------------ */
/* Walker: streaming parser of one HTTP response                      */
/* ------------------------------------------------------------------ */

const SEARCH_TAIL = 16;

class Walker {
    /**
     * @param {Session} session
     * @param {number} offset - absolute offset of the first byte that will be fed
     */
    constructor(session, offset) {
        this.s = session;
        this.pos = offset;      // absolute offset of the next byte to consume
        this.stack = [];
        this.st = offset === 0 ? { t: 'header' } : { t: 'resync' };
        this.hb = Buffer.alloc(12);
        this.hl = 0;
        this.tail = Buffer.alloc(0);
        this.errors = 0;
    }

    feed(chunk) {
        let i = 0;

        while (i < chunk.length) {
            const st = this.st;

            if (st.t === 'skip') {
                const n = Math.min(st.left, chunk.length - i);

                st.left -= n;
                i += n;
                this.pos += n;

                if (!st.left) this.st = { t: 'header' };

                continue;
            }

            if (st.t === 'collect') {
                const n = Math.min(st.left, chunk.length - i);

                st.parts.push(chunk.slice(i, i + n));
                st.left -= n;
                i += n;
                this.pos += n;

                if (!st.left) {
                    this.st = { t: 'header' };
                    st.done(st.parts.length === 1 ? st.parts[0] : Buffer.concat(st.parts));
                }

                continue;
            }

            if (st.t === 'resync') {
                this.resync(chunk.slice(i));
                return;
            }

            // element header
            this.closeEnded();

            const k = this.hl;
            const take = Math.min(12 - k, chunk.length - i);

            chunk.copy(this.hb, k, i, i + take);

            const h = parseHeader(this.hb, k + take);

            if (h === null) {
                this.hl = k + take;
                i += take;
                this.pos += take;
                continue;
            }

            if (h === false) {
                // lost track of the structure: look for the next cluster from here
                this.hl = 0;
                this.toResync();
                continue;
            }

            const used = h.len - k;

            this.hl = 0;
            i += used;
            this.pos += used;

            this.element(h.id, h.size);
        }
    }

    /** The response is over: emit a pending block group if it ended right at the end of the data */
    end() {
        if (this.st.t === 'header' && !this.hl) this.closeEnded();
    }

    toResync() {
        this.errors++;
        this.stack = [];
        this.tail = Buffer.alloc(0);
        this.st = { t: 'resync' };
    }

    /**
     * Look for a Cluster: 1F 43 B6 75, a valid size, then Timestamp (E7) or CRC-32 (BF)
     */
    resync(data) {
        const buf = this.tail.length ? Buffer.concat([this.tail, data]) : data;
        const base = this.pos - this.tail.length;
        let from = 0;

        for (;;) {
            const m = buf.indexOf(0x1F, from);

            if (m < 0 || m + 4 > buf.length) break;

            if (buf[m + 1] === 0x43 && buf[m + 2] === 0xB6 && buf[m + 3] === 0x75) {
                if (m + 13 > buf.length) {
                    // not enough bytes to check, wait for more
                    this.tail = Buffer.from(buf.slice(m));
                    this.pos = base + buf.length;
                    return;
                }

                const h = parseHeader(buf.slice(m, m + 12), 12);

                if (h && h.id === ID.CLUSTER) {
                    const next = buf[m + h.len];

                    if (next === 0xE7 || next === 0xBF) {
                        this.tail = Buffer.alloc(0);
                        this.pos = base + m;
                        this.stack = [{ id: ID.SEGMENT, end: Infinity }];
                        this.st = { t: 'header' };
                        this.feed(buf.slice(m));
                        return;
                    }
                }
            }

            from = m + 1;
        }

        this.tail = Buffer.from(buf.slice(Math.max(0, buf.length - SEARCH_TAIL)));
        this.pos = base + buf.length;
    }

    top() {
        return this.stack[this.stack.length - 1];
    }

    cluster() {
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (this.stack[i].id === ID.CLUSTER) return this.stack[i];
        }

        return null;
    }

    pop() {
        const frame = this.stack.pop();

        if (frame && frame.id === ID.BLOCK_GROUP && frame.block) this.emit(frame.block, frame.duration);

        return frame;
    }

    closeEnded() {
        while (this.stack.length) {
            const top = this.top();

            if (top.end !== Infinity && this.pos >= top.end) this.pop();
            else break;
        }
    }

    skip(size) {
        this.st = size > 0 ? { t: 'skip', left: size } : { t: 'header' };
    }

    collect(size, done) {
        if (size <= 0) {
            this.st = { t: 'header' };
            done(Buffer.alloc(0));
        } else {
            this.st = { t: 'collect', left: size, parts: [], done };
        }
    }

    push(id, size, extra) {
        const frame = Object.assign({ id, end: size < 0 ? Infinity : this.pos + size }, extra || {});

        this.stack.push(frame);
        this.st = { t: 'header' };

        return frame;
    }

    element(id, size) {
        // a level-1 element ends a cluster of unknown size
        if (LEVEL1.has(id)) {
            while (this.stack.length && this.top().id !== ID.SEGMENT) this.pop();
        }

        const top = this.top();
        const topId = top ? top.id : 0;

        if (id === ID.EBML) return size < 0 ? this.toResync() : this.skip(size);

        if (id === ID.SEGMENT) {
            this.stack = [];
            this.push(id, size);
            return;
        }

        if (id === ID.CLUSTER) {
            this.push(id, size, { time: null });
            return;
        }

        if (id === ID.INFO && topId === ID.SEGMENT && size >= 0 && size < MAX_HEADER_ELEMENT) {
            return this.collect(size, (buf) => this.s.setInfo(buf));
        }

        if (id === ID.TRACKS && topId === ID.SEGMENT && size >= 0 && size < MAX_HEADER_ELEMENT) {
            return this.collect(size, (buf) => this.s.setTracks(buf));
        }

        if (topId === ID.CLUSTER) {
            if (id === ID.TIMESTAMP) {
                return this.collect(size, (buf) => {
                    top.time = readUint(buf);
                    this.s.readTime = top.time * this.s.scale / 1e9;
                });
            }

            if (id === ID.SIMPLE_BLOCK) return this.block(size, null);
            if (id === ID.BLOCK_GROUP) return this.push(id, size, { block: null, duration: null });
        }

        if (topId === ID.BLOCK_GROUP) {
            if (id === ID.BLOCK) return this.block(size, top);
            if (id === ID.BLOCK_DURATION) return this.collect(size, (buf) => { top.duration = readUint(buf); });
        }

        if (size < 0) return this.toResync();

        this.skip(size);
    }

    /**
     * Read the head of a block: track number; keep the whole block only for text subtitles
     */
    block(size, group) {
        if (size <= 0) return this.skip(size);

        const headLen = Math.min(size, 4);

        this.collect(headLen, (head) => {
            const vlen = leadingZeros(head[0]) + 1;
            let track = null;

            if (head[0] !== 0 && vlen <= headLen) {
                let num = head[0] & (0xFF >> vlen);

                for (let i = 1; i < vlen; i++) num = num * 256 + head[i];

                track = this.s.track(num);
            }

            const rest = size - headLen;

            if (!track || !track.text || size > MAX_TEXT_BLOCK) return this.skip(rest);

            this.collect(rest, (tail) => {
                const full = Buffer.concat([head, tail]);
                const parsed = this.parseBlock(full, track);

                if (!parsed) return;

                if (group) group.block = parsed;
                else this.emit(parsed, null);
            });
        });
    }

    parseBlock(buf, track) {
        const vlen = leadingZeros(buf[0]) + 1;

        if (buf.length < vlen + 3) return null;

        const rel = buf.readInt16BE(vlen);
        const flags = buf[vlen + 2];

        // laced subtitle blocks are not used in practice
        if (flags & 0x06) return null;

        const cluster = this.cluster();

        if (!cluster || cluster.time === null) return null;

        return { track, time: cluster.time + rel, payload: buf.slice(vlen + 3) };
    }

    emit(block, duration) {
        const decoded = blockText(block.track, block.payload);

        if (!decoded || !decoded.text) return;

        const scale = this.s.scale / 1e9;
        const start = block.time * scale;
        const end = duration ? start + duration * scale : start + DEFAULT_CUE_DURATION;

        this.s.addCue(block.track.number, start, end, decoded.text, decoded.style);
    }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const sessions = new Map();

function log() {
    const args = Array.prototype.slice.call(arguments);

    args.unshift(new Date().toISOString());
    console.log.apply(console, args);
}

/** Session key: the stream URL without the play/preload flags of TorrServer */
function sessionKey(url) {
    try {
        const u = new URL(url);

        u.searchParams.delete('play');
        u.searchParams.delete('preload');
        u.hash = '';

        return u.toString();
    } catch (e) {
        return String(url);
    }
}

function getSession(url, create) {
    const key = sessionKey(url);
    let s = sessions.get(key);

    if (!s && create) {
        s = new Session(key);
        sessions.set(key, s);
    }

    if (s) s.touched = Date.now();

    return s || null;
}

function cors(headers) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
    headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges';
    headers['Access-Control-Allow-Private-Network'] = 'true';

    return headers;
}

function json(res, code, data) {
    const body = JSON.stringify(data);

    res.writeHead(code, cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(body);
}

const FORWARD_REQUEST = ['range', 'if-range', 'user-agent', 'accept', 'accept-encoding'];
const FORWARD_RESPONSE = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];

function proxy(req, res, target) {
    let upstream;

    try {
        upstream = new URL(target);
    } catch (e) {
        return json(res, 400, { error: 'bad url' });
    }

    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return json(res, 400, { error: 'bad protocol' });

    const headers = {};

    FORWARD_REQUEST.forEach((name) => {
        if (req.headers[name]) headers[name] = req.headers[name];
    });

    // the parser needs the raw bytes
    headers['accept-encoding'] = 'identity';

    const lib = upstream.protocol === 'https:' ? https : http;
    let finished = false;

    const ureq = lib.request({
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname + upstream.search,
        headers
    }, (ures) => {
        const out = {};

        FORWARD_RESPONSE.forEach((name) => {
            if (ures.headers[name] !== undefined) out[name] = ures.headers[name];
        });

        res.writeHead(ures.statusCode, cors(out));

        if (req.method === 'HEAD') {
            ures.resume();
            res.end();
            return;
        }

        let walker = null;

        if (ures.statusCode === 200 || ures.statusCode === 206) {
            let offset = 0;

            if (ures.statusCode === 206) {
                const m = /bytes\s+(\d+)-/i.exec(ures.headers['content-range'] || '');

                offset = m ? parseInt(m[1], 10) : -1;
            }

            if (offset >= 0) {
                const session = getSession(target, true);

                walker = new Walker(session, offset);
                session.walkers++;

                let released = false;
                const release = () => {
                    if (released) return;

                    released = true;
                    session.walkers--;
                    session.touched = Date.now();
                };

                ures.on('end', release);
                ures.on('close', release);
                ures.on('aborted', release);
            }
        }

        ures.on('data', (chunk) => {
            if (walker) {
                try {
                    walker.feed(chunk);
                } catch (e) {
                    log('parser error', e && e.stack || e);
                    walker = null;
                }
            }

            if (!res.write(chunk)) {
                ures.pause();
                res.once('drain', () => ures.resume());
            }
        });

        ures.on('end', () => {
            if (walker) {
                try {
                    walker.end();
                } catch (e) { }
            }

            res.end();
        });
        ures.on('error', () => res.destroy());
    });

    ureq.on('error', (e) => {
        log('upstream error', e.message);

        if (!res.headersSent) json(res, 502, { error: e.message });
        else res.destroy();
    });

    res.on('finish', () => { finished = true; });
    res.on('close', () => {
        if (!finished) ureq.destroy();
    });

    ureq.end();
}

function handle(req, res) {
    let url;

    try {
        url = new URL(req.url, 'http://local');
    } catch (e) {
        return json(res, 400, { error: 'bad request' });
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors({ 'Access-Control-Max-Age': '86400' }));
        return res.end();
    }

    const path = url.pathname;
    const target = url.searchParams.get('u');

    if (path === '/health') return json(res, 200, { ok: true, version: VERSION, sessions: sessions.size });

    if (path === '/v' || path.indexOf('/v/') === 0) {
        if (!target) return json(res, 400, { error: 'no url' });

        return proxy(req, res, target);
    }

    if (path === '/tracks') {
        const s = target && getSession(target, false);

        return json(res, 200, s ? s.info() : { ready: false, tracks: [] });
    }

    if (path === '/subs') {
        const s = target && getSession(target, false);

        if (!s) return json(res, 200, { ready: false, readTime: 0, cues: [] });

        const track = parseInt(url.searchParams.get('track'), 10);
        const from = parseFloat(url.searchParams.get('from')) || 0;
        const to = parseFloat(url.searchParams.get('to'));

        return json(res, 200, {
            ready: !!s.tracks,
            readTime: s.readTime,
            cues: s.window(track, from, isNaN(to) ? Infinity : to)
        });
    }

    json(res, 404, { error: 'not found' });
}

function gc() {
    const now = Date.now();

    sessions.forEach((s, key) => {
        if (!s.walkers && now - s.touched > SESSION_IDLE) sessions.delete(key);
    });
}

function start() {
    const server = http.createServer(handle);

    server.keepAliveTimeout = 65000;
    server.listen(PORT, HOST, () => log('subtitles-plus proxy', VERSION, 'on', HOST + ':' + PORT));
    server.on('error', (e) => {
        log('server error', e.message);
        process.exit(1);
    });

    setInterval(gc, 5 * 60 * 1000).unref();
}

if (require.main === module) start();

module.exports = { Session, Walker, parseHeader, parseTracks, blockText, sessionKey, handle, sessions, VERSION };
