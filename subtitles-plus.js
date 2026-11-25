/**
 * "Subtitles: Plus" plugin for Lampa
 *
 * Adds the "Subtitles: Plus" item to the settings menu of the built-in player (the gear in the player
 * panel), right after the built-in "Subtitles" item. When enabled, the plugin draws subtitles in its own
 * layer with its own settings, independent of the built-in subtitle settings of Lampa:
 * size, colour, opacity, position on the screen, delay (+/-), backdrop and outline/shadow.
 *
 * Disabled by default: until it is turned on, Lampa shows subtitles as usual.
 *
 * Where the text comes from, in this order:
 *   1. external srt/vtt chosen in the player (video.customSubs): the plugin loads and parses the file itself;
 *   2. native text tracks of <video> with cues;
 *   3. anything else (HLS.js, Tizen AVPlay...): a mirror of the built-in subtitle layer of Lampa.
 *      There is no future text here, so only a positive delay works.
 * Subtitles rendered by the TV itself (webOS media service) are not affected.
 *
 * Plain ES5, no build step: the file is the plugin entry point.
 */
(function () {
    'use strict';

    var VERSION = '2.0.0';
    var AUTHOR = '@etix';
    var FILE_PATTERN = /\/subtitles-plus\.js(\?|#|$)/i;
    var STYLE_ID = 'subs-plus-style';
    var PREFIX = 'subs_plus_';
    var TICK = 100;
    var MIRROR_KEEP = 20;

    var TITLE = {
        ru: 'Субтитры: Plus',
        en: 'Subtitles: Plus',
        uk: 'Субтитри: Plus',
        be: 'Субтытры: Plus'
    };

    var SCRIPT_SRC = '';

    try {
        SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
    } catch (e) { }

    /* ------------------------------------------------------------------ */
    /* Options                                                             */
    /* ------------------------------------------------------------------ */

    // font size of .player-video__subtitles in css/app.css with the "normal" size of Lampa
    var BASE_EM = 2.5;

    var COLORS = {
        white: [255, 255, 255],
        yellow: [255, 255, 0],
        green: [0, 255, 0],
        cyan: [0, 255, 255],
        blue: [64, 128, 255],
        red: [255, 64, 64],
        magenta: [255, 0, 255],
        gray: [160, 160, 160],
        black: [0, 0, 0]
    };

    var BG_COLORS = {
        black: [0, 0, 0],
        gray: [80, 80, 80],
        white: [255, 255, 255],
        blue: [0, 40, 120]
    };

    var EDGE_COLORS = {
        black: [0, 0, 0],
        gray: [80, 80, 80],
        white: [255, 255, 255]
    };

    var DELAYS = [-10, -5, -3, -2, -1.5, -1, -0.75, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];

    function percents(list) {
        return list.map(function (v) {
            return { value: String(v), label: v + '%' };
        });
    }

    function named(list, prefix) {
        return list.map(function (v) {
            return { value: v, key: prefix + v };
        });
    }

    function delayLabel(value) {
        var n = parseFloat(value);
        var sign = n > 0 ? '+' : n < 0 ? '−' : '';

        return sign + Math.abs(n) + ' ' + t('subs_plus_sec');
    }

    // order of the menu after "Enabled"; `def` is the default value
    var OPTIONS = [
        {
            name: 'size',
            def: '100',
            values: percents([50, 60, 70, 80, 90, 100, 110, 120, 135, 150, 175, 200, 250])
        },
        {
            name: 'color',
            def: 'white',
            values: named(['white', 'yellow', 'green', 'cyan', 'blue', 'red', 'magenta', 'gray', 'black'], 'subs_plus_color_')
        },
        {
            name: 'opacity',
            def: '100',
            values: percents([100, 90, 75, 60, 50, 25])
        },
        {
            name: 'vertical',
            def: 'bottom',
            values: named(['bottom', 'middle', 'top'], 'subs_plus_vertical_')
        },
        {
            name: 'offset',
            def: '5',
            values: percents([0, 2, 5, 10, 15, 20, 25, 30])
        },
        {
            name: 'horizontal',
            def: 'center',
            values: named(['left', 'center', 'right'], 'subs_plus_horizontal_')
        },
        {
            name: 'delay',
            def: '0',
            values: DELAYS.map(function (v) {
                return { value: String(v), delay: true };
            })
        },
        {
            name: 'bg',
            def: 'none',
            values: [{ value: 'none', key: 'subs_plus_none' }].concat(named(['black', 'gray', 'white', 'blue'], 'subs_plus_bg_'))
        },
        {
            name: 'bg_opacity',
            def: '55',
            values: percents([10, 25, 40, 55, 75, 90, 100])
        },
        {
            name: 'edge',
            def: 'outline',
            values: [{ value: 'none', key: 'subs_plus_none' }]
                .concat(named(['outline', 'outline_thick', 'shadow', 'raised', 'depressed', 'glow'], 'subs_plus_edge_'))
        },
        {
            name: 'edge_color',
            def: 'black',
            values: named(['black', 'gray', 'white'], 'subs_plus_color_')
        }
    ];

    // value tried on the preview while the user moves over a value list; not saved yet
    var override = null;

    // the gear menu of the player, to come back to it
    var rootParams = null;

    // the params of the Select shown last
    var currentSelect = null;

    var previewOn = false;

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function t(key) {
        return Lampa.Lang.translate(key);
    }

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('SubsPlus');
        console.log.apply(console, args);
    }

    function option(name) {
        for (var i = 0; i < OPTIONS.length; i++) {
            if (OPTIONS[i].name === name) return OPTIONS[i];
        }

        return null;
    }

    function findValue(opt, value) {
        for (var i = 0; i < opt.values.length; i++) {
            if (opt.values[i].value === value) return opt.values[i];
        }

        return null;
    }

    function get(name) {
        var opt = option(name);

        if (override && override.name === name) return override.value;

        var value = String(Lampa.Storage.get(PREFIX + name, opt.def));

        // an unknown value (old version, manual edit) falls back to the default
        return findValue(opt, value) ? value : opt.def;
    }

    function set(name, value) {
        Lampa.Storage.set(PREFIX + name, value);
    }

    function enabled() {
        var value = Lampa.Storage.get(PREFIX + 'enabled', false);

        return value === true || value === 'true';
    }

    function label(name, value) {
        var item = findValue(option(name), value);

        if (!item) return value;
        if (item.delay) return delayLabel(item.value);

        return item.key ? t(item.key) : item.label;
    }

    function rgba(rgb, alpha) {
        return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (Math.round(alpha * 1000) / 1000) + ')';
    }

    function round(n) {
        return Math.round(n * 1000) / 1000;
    }

    /* ------------------------------------------------------------------ */
    /* Style                                                               */
    /* ------------------------------------------------------------------ */

    function ring(radius, color) {
        var d = radius + 'em';
        var h = round(radius * 0.7) + 'em';
        var n = '-' + d;
        var nh = '-' + h;

        return [
            d + ' 0 0 ' + color, n + ' 0 0 ' + color, '0 ' + d + ' 0 ' + color, '0 ' + n + ' 0 ' + color,
            h + ' ' + h + ' 0 ' + color, nh + ' ' + h + ' 0 ' + color, h + ' ' + nh + ' 0 ' + color, nh + ' ' + nh + ' 0 ' + color
        ];
    }

    /**
     * text-shadow for the outline style; only text-shadow, in em so it scales with the size and
     * works on old webOS/Tizen browsers without -webkit-text-stroke
     */
    function edgeShadow(edge, rgb) {
        var c = rgba(rgb, 1);
        var light = 'rgba(255,255,255,0.6)';

        if (edge === 'outline') return ring(0.04, c).join(', ');
        if (edge === 'outline_thick') return ring(0.08, c).concat(ring(0.04, c)).join(', ');
        if (edge === 'shadow') return '0.06em 0.06em 0.1em ' + c + ', 0.03em 0.03em 0.03em ' + c;
        if (edge === 'raised') return '-0.03em -0.03em 0 ' + light + ', 0.04em 0.04em 0 ' + c;
        if (edge === 'depressed') return '0.03em 0.03em 0 ' + light + ', -0.04em -0.04em 0 ' + c;
        if (edge === 'glow') return '0 0 0.12em ' + c + ', 0 0 0.25em ' + c + ', 0 0 0.4em ' + c;

        return 'none';
    }

    var FLEX = { top: 'flex-start', middle: 'center', bottom: 'flex-end', left: 'flex-start', center: 'center', right: 'flex-end' };

    function buildCss() {
        var em = round(BASE_EM * parseInt(get('size'), 10) / 100);
        var bg = get('bg');
        var vertical = get('vertical');
        var horizontal = get('horizontal');
        var offset = vertical === 'middle' ? 0 : parseInt(get('offset'), 10);

        // lift over the open player panel; 3.6em of the "normal" Lampa size, kept constant for any size
        var lift = round(3.6 * BASE_EM / em);

        var padding = (vertical === 'top' ? offset + 'vh' : '0') + ' 0.6em ' + (vertical === 'bottom' ? offset + 'vh' : '0');

        return [
            // structure
            '.subs-plus{display:none;position:fixed;top:0;left:0;right:0;bottom:0;box-sizing:border-box;pointer-events:none;' +
            '-webkit-box-orient:vertical;-webkit-flex-direction:column;flex-direction:column;' +
            '-webkit-transition:-webkit-transform 0.2s;transition:transform 0.2s}',
            'body.subs-plus--on .subs-plus, body.subs-plus--preview .subs-plus{display:-webkit-box;display:-webkit-flex;display:flex}',
            '.subs-plus__line{max-width:100%}',
            '.subs-plus__text{display:inline-block;padding:0.25em 0.5em;-webkit-border-radius:0.25em;border-radius:0.25em;font-weight:600;line-height:1.25}',
            '.subs-plus__text:empty{display:none}',
            'body.subs-plus--on .player-video__subtitles, body.subs-plus--preview .player-video__subtitles{visibility:hidden !important}',
            'body.subs-plus--on video::cue{color:transparent !important;background:transparent !important;text-shadow:none !important}',

            // settings
            '.subs-plus{font-size:' + em + 'em;padding:' + padding + ';' +
            '-webkit-box-pack:' + FLEX[vertical] + ';-webkit-justify-content:' + FLEX[vertical] + ';justify-content:' + FLEX[vertical] + ';' +
            '-webkit-box-align:' + FLEX[horizontal] + ';-webkit-align-items:' + FLEX[horizontal] + ';align-items:' + FLEX[horizontal] + '}',
            '.subs-plus__line{text-align:' + horizontal + ';opacity:' + (parseInt(get('opacity'), 10) / 100) + '}',
            '.subs-plus__text{color:' + rgba(COLORS[get('color')], 1) + ';' +
            'background:' + (bg === 'none' ? 'transparent' : rgba(BG_COLORS[bg], parseInt(get('bg_opacity'), 10) / 100)) + ';' +
            'text-shadow:' + edgeShadow(get('edge'), EDGE_COLORS[get('edge_color')]) + '}',
            vertical === 'bottom' ? '.player.player--panel-visible .subs-plus{-webkit-transform:translate3d(0,-' + lift + 'em,0);transform:translate3d(0,-' + lift + 'em,0)}' : ''
        ].join('\n');
    }

    function applyStyle() {
        var css;

        try {
            css = buildCss();
        } catch (e) {
            log('cannot build style', e);
            return;
        }

        var style = document.getElementById(STYLE_ID);

        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            style.type = 'text/css';
            (document.head || document.body).appendChild(style);
        }

        style.textContent = css;
    }

    function applyState() {
        $('body').toggleClass('subs-plus--on', enabled());
        $('body').toggleClass('subs-plus--preview', previewOn);
        applyStyle();
    }

    /* ------------------------------------------------------------------ */
    /* Parsing                                                             */
    /* ------------------------------------------------------------------ */

    // "01:02:03,456", "02:03.456", "1:02:03.4" → seconds
    function parseTime(str) {
        var parts = String(str).trim().replace(',', '.').split(':');
        var seconds = 0;

        for (var i = 0; i < parts.length; i++) seconds = seconds * 60 + parseFloat(parts[i]);

        return isNaN(seconds) ? -1 : seconds;
    }

    // keeps <i> <b> <u> <font>, drops ASS-like {\an8} tags and VTT <c.x> <v Name> <00:00:01.000>
    function cleanText(text) {
        return String(text || '')
            .replace(/\{\\[^}]*\}/g, '')
            .replace(/<\/?(c|v|ruby|rt|lang)([.\s][^>]*)?>/gi, '')
            .replace(/<\d+:[\d:.]+>/g, '')
            .replace(/^\s+|\s+$/g, '')
            .replace(/\n/g, '<br>');
    }

    /**
     * SRT and WebVTT into [{start, end, text}] sorted by start, in seconds
     */
    function parseSubs(data) {
        var blocks = String(data || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
        var timing = /([\d:.,]+)[ \t]*-->[ \t]*([\d:.,]+)/;
        var cues = [];

        for (var b = 0; b < blocks.length; b++) {
            var lines = blocks[b].split('\n');

            for (var l = 0; l < lines.length; l++) {
                var m = timing.exec(lines[l]);

                if (!m) continue;

                var start = parseTime(m[1]);
                var end = parseTime(m[2]);
                var text = cleanText(lines.slice(l + 1).join('\n'));

                if (start >= 0 && end > start && text) cues.push({ start: start, end: end, text: text });

                break;
            }
        }

        cues.sort(function (a, c) {
            return a.start - c.start;
        });

        return cues;
    }

    function textAt(cues, time) {
        var out = [];

        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];

            if (c.start > time) break;
            if (time >= c.start && time < c.end) out.push(c.text);
        }

        return out.join('<br>');
    }

    /* ------------------------------------------------------------------ */
    /* Sources                                                             */
    /* ------------------------------------------------------------------ */

    // url → {status: 'loading'|'ok'|'error', cues}
    var files = {};

    function loadFile(url) {
        if (files[url]) return files[url];

        var entry = files[url] = { status: 'loading', cues: [] };

        try {
            var network = new Lampa.Reguest();

            network.silent(url, function (data) {
                entry.cues = parseSubs(typeof data === 'string' ? data : '');
                entry.status = entry.cues.length ? 'ok' : 'error';

                log('loaded', url, entry.cues.length, 'cues');
            }, function () {
                entry.status = 'error';

                log('cannot load', url);
            }, false, { dataType: 'text' });
        } catch (e) {
            entry.status = 'error';

            log('cannot load', url, e);
        }

        return entry;
    }

    // text of a native track at the time, read from track.cues without copying them
    function trackTextAt(track, time) {
        var list = track.cues;
        var out = [];

        for (var i = 0; i < list.length; i++) {
            var c = list[i];

            if (time >= c.startTime && time < c.endTime) out.push(cleanText(c.text));
        }

        return out.join('<br>');
    }

    /**
     * Active source of the current video: {type: 'file'|'cues'|'mirror', ...}
     */
    function activeSource(video) {
        var custom = video.customSubs;
        var i;

        if (custom && custom.length) {
            for (i = 0; i < custom.length; i++) {
                if (custom[i] && custom[i].selected && custom[i].url) {
                    var file = loadFile(custom[i].url);

                    if (file.status === 'ok') return { type: 'file', cues: file.cues };

                    // still loading, or a format we cannot parse: Lampa draws it, mirror that
                    return { type: 'mirror' };
                }
            }
        }

        var tracks = video.textTracks;

        if (tracks && tracks.length) {
            for (i = 0; i < tracks.length; i++) {
                var track = tracks[i];

                if (track && track.mode === 'showing' && track.cues && track.cues.length) return { type: 'cues', track: track };
            }
        }

        return { type: 'mirror' };
    }

    // mirror of the built-in layer: [{time, text}] in video time
    var mirror = [];

    function lampaText() {
        var layer = Lampa.PlayerVideo.render().find('.player-video__subtitles');
        var inner = layer.find('.player-video__subtitles-text');

        if (!layer.length || layer.hasClass('hide') || inner.css('display') === 'none') return '';

        var html = inner.html() || '';

        return html.replace(/&nbsp;/g, ' ').replace(/^\s+|\s+$/g, '') ? html : '';
    }

    function mirrorText(now, delay) {
        var text = lampaText();
        var last = mirror[mirror.length - 1];

        // went back in time without a seeking event
        if (last && now < last.time) mirror = [];

        last = mirror[mirror.length - 1];

        if (!last || last.text !== text) mirror.push({ time: now, text: text });

        // drop old records, keeping the one in effect at now - MIRROR_KEEP
        while (mirror.length > 1 && mirror[1].time <= now - MIRROR_KEEP) mirror.shift();

        if (delay <= 0) return text;

        var target = now - delay;
        var found = '';

        for (var i = 0; i < mirror.length; i++) {
            if (mirror[i].time <= target) found = mirror[i].text;
            else break;
        }

        return found;
    }

    /* ------------------------------------------------------------------ */
    /* Layer                                                               */
    /* ------------------------------------------------------------------ */

    var layer = null;
    var shownText = null;
    var timer = null;
    var lastSource = '';

    function getLayer() {
        var player;

        try {
            player = Lampa.PlayerVideo.render();
        } catch (e) {
            return null;
        }

        if (!player || !player.length) return null;

        if (!layer || !$.contains(player[0], layer[0])) {
            player.find('.subs-plus').remove();

            layer = $('<div class="subs-plus"><div class="subs-plus__line"><span class="subs-plus__text"></span></div></div>');
            shownText = null;

            player.append(layer);
        }

        return layer;
    }

    function show(text) {
        var el = getLayer();

        if (!el || text === shownText) return;

        shownText = text;
        el.find('.subs-plus__text').html(text);
    }

    function tick() {
        if (previewOn) return show(t('subs_plus_sample'));
        if (!enabled()) return show('');

        var video;

        try {
            video = Lampa.PlayerVideo.video();
        } catch (e) { }

        if (!video) return show('');

        var now = video.currentTime || 0;
        var delay = parseFloat(get('delay')) || 0;
        var source = activeSource(video);

        lastSource = source.type;

        if (source.type === 'file') show(textAt(source.cues, now - delay));
        else if (source.type === 'cues') show(trackTextAt(source.track, now - delay));
        else show(mirrorText(now, delay));

        if (!video._subs_plus_bound) {
            video._subs_plus_bound = true;

            video.addEventListener('seeking', function () {
                mirror = [];
            });
        }
    }

    function start() {
        mirror = [];
        lastSource = '';

        if (!timer) timer = setInterval(tick, TICK);
    }

    function stop() {
        clearInterval(timer);
        timer = null;
        mirror = [];
        files = {};
        show('');
    }

    /* ------------------------------------------------------------------ */
    /* Preview                                                             */
    /* ------------------------------------------------------------------ */

    function setPreview(status) {
        if (previewOn === status) return;

        previewOn = status;

        applyState();
        tick();
    }

    function isOwn(params) {
        return !!(params && params._subs_plus);
    }

    // after hide/close Lampa may open the next select from onBack; check once it is settled
    function checkPreview() {
        setTimeout(function () {
            var opened = true;

            try {
                opened = Lampa.Select.opened();
            } catch (e) { }

            if (!opened || !isOwn(currentSelect)) {
                override = null;
                setPreview(false);
            }
        }, 0);
    }

    /* ------------------------------------------------------------------ */
    /* Menu                                                                */
    /* ------------------------------------------------------------------ */

    function summary() {
        if (!enabled()) return t('subs_plus_off');

        var parts = [t('subs_plus_on'), label('size', get('size')), label('color', get('color'))];

        if (get('delay') !== '0') parts.push(label('delay', get('delay')));

        return parts.join(' · ');
    }

    function delaySubtitle() {
        var text = label('delay', get('delay'));

        if (enabled() && lastSource === 'mirror' && parseFloat(get('delay')) < 0) text += ' · ' + t('subs_plus_delay_mirror');

        return text;
    }

    function backToRoot() {
        setPreview(false);

        if (rootParams) {
            rootParams.items.forEach(function (item) {
                item.selected = item.method === 'subs_plus';

                if (item.method === 'subs_plus') item.subtitle = summary();
            });

            Lampa.Select.show(rootParams);
        } else {
            Lampa.Controller.toggle(Lampa.Platform.screen('mobile') ? 'player' : 'player_panel');
        }
    }

    function openMain(focus) {
        var items = [{
            title: t('subs_plus_enabled'),
            subtitle: t('subs_plus_enabled_descr'),
            name: 'enabled',
            checkbox: true,
            checked: enabled(),
            selected: focus === 'enabled' || !focus
        }];

        OPTIONS.forEach(function (opt) {
            items.push({
                title: t('subs_plus_' + opt.name),
                subtitle: opt.name === 'delay' ? delaySubtitle() : label(opt.name, get(opt.name)),
                name: opt.name,
                selected: opt.name === focus
            });
        });

        items.push({
            title: t('subs_plus_reset'),
            subtitle: t('subs_plus_reset_descr'),
            name: 'reset',
            selected: focus === 'reset'
        });

        Lampa.Select.show({
            title: t('subs_plus_title'),
            items: items,
            nomark: true,
            nohide: true,
            _subs_plus: true,
            onBack: backToRoot,
            onCheck: function (a) {
                if (a.name !== 'enabled') return;

                set('enabled', a.checked ? 'true' : 'false');
                applyState();
            },
            onSelect: function (a) {
                if (a.name === 'reset') {
                    OPTIONS.forEach(function (opt) {
                        set(opt.name, opt.def);
                    });

                    applyState();
                    openMain('reset');
                } else if (option(a.name)) openValues(a.name);
            }
        });

        setPreview(true);
    }

    function openValues(name) {
        var opt = option(name);
        var current = get(name);

        var items = opt.values.map(function (v) {
            return {
                title: v.delay ? delayLabel(v.value) : v.key ? t(v.key) : v.label,
                subtitle: v.delay && v.value === '0' ? t('subs_plus_delay_descr') : '',
                value: v.value,
                selected: v.value === current
            };
        });

        // a delay is checked on the real subtitles, not on the sample text
        var live = name === 'delay';

        Lampa.Select.show({
            title: t('subs_plus_' + name),
            items: items,
            nohide: true,
            _subs_plus: true,
            onFocus: function (a) {
                override = { name: name, value: a.value };
                applyStyle();
            },
            onBack: function () {
                override = null;
                applyStyle();
                openMain(name);
            },
            onSelect: function (a) {
                override = null;
                set(name, a.value);
                applyState();
                openMain(name);
            }
        });

        setPreview(!live);
    }

    /**
     * Add our item to the gear menu of the player before Lampa draws it
     */
    function onSelectPreshow(e) {
        var params = e && e.active;

        currentSelect = params;

        if (!isOwn(params)) {
            override = null;
            setPreview(false);
        }

        if (!params || params._subs_plus_root || !params.items || typeof params.onSelect !== 'function') return;
        if (params.title !== t('title_settings')) return;

        var subsIndex = -1;
        var hasSpeed = false;

        for (var i = 0; i < params.items.length; i++) {
            if (params.items[i].method === 'subs') subsIndex = i;
            if (params.items[i].method === 'speed') hasSpeed = true;
        }

        if (subsIndex < 0 || !hasSpeed) return;

        var original = params.onSelect;

        params.items.splice(subsIndex + 1, 0, {
            title: t('subs_plus_title'),
            subtitle: summary(),
            method: 'subs_plus'
        });

        params.onSelect = function (a) {
            if (a && a.method === 'subs_plus') openMain();
            else return original.apply(this, arguments);
        };

        params._subs_plus_root = true;
        rootParams = params;
    }

    /* ------------------------------------------------------------------ */
    /* Translations                                                        */
    /* ------------------------------------------------------------------ */

    function addTranslations() {
        Lampa.Lang.add({
            subs_plus_title: TITLE,
            subs_plus_enabled: { ru: 'Включено', en: 'Enabled', uk: 'Увімкнено', be: 'Уключана' },
            subs_plus_enabled_descr: {
                ru: 'Показывать субтитры с настройками ниже вместо встроенных',
                en: 'Show subtitles with the settings below instead of the built-in look',
                uk: 'Показувати субтитри з налаштуваннями нижче замість вбудованих',
                be: 'Паказваць субтытры з наладамі ніжэй замест убудаваных'
            },
            subs_plus_on: { ru: 'Вкл', en: 'On', uk: 'Увімк', be: 'Укл' },
            subs_plus_off: { ru: 'Выкл', en: 'Off', uk: 'Вимк', be: 'Выкл' },
            subs_plus_size: { ru: 'Размер', en: 'Size', uk: 'Розмір', be: 'Памер' },
            subs_plus_color: { ru: 'Цвет текста', en: 'Text colour', uk: 'Колір тексту', be: 'Колер тэксту' },
            subs_plus_opacity: { ru: 'Прозрачность', en: 'Opacity', uk: 'Прозорість', be: 'Празрыстасць' },
            subs_plus_vertical: { ru: 'По вертикали', en: 'Vertical position', uk: 'По вертикалі', be: 'Па вертыкалі' },
            subs_plus_offset: { ru: 'Отступ от края', en: 'Edge margin', uk: 'Відступ від краю', be: 'Адступ ад краю' },
            subs_plus_horizontal: { ru: 'По горизонтали', en: 'Horizontal position', uk: 'По горизонталі', be: 'Па гарызанталі' },
            subs_plus_delay: { ru: 'Задержка', en: 'Delay', uk: 'Затримка', be: 'Затрымка' },
            subs_plus_delay_descr: {
                ru: '«+» — субтитры позже, «−» — раньше',
                en: '"+" shows subtitles later, "−" earlier',
                uk: '«+» — субтитри пізніше, «−» — раніше',
                be: '«+» — субтытры пазней, «−» — раней'
            },
            subs_plus_delay_mirror: {
                ru: 'для этой дорожки работает только «+»',
                en: 'only "+" works for this track',
                uk: 'для цієї доріжки працює лише «+»',
                be: 'для гэтай дарожкі працуе толькі «+»'
            },
            subs_plus_sec: { ru: 'с', en: 's', uk: 'с', be: 'с' },
            subs_plus_bg: { ru: 'Подложка', en: 'Backdrop', uk: 'Підкладка', be: 'Падкладка' },
            subs_plus_bg_opacity: { ru: 'Прозрачность подложки', en: 'Backdrop opacity', uk: 'Прозорість підкладки', be: 'Празрыстасць падкладкі' },
            subs_plus_edge: { ru: 'Обрамление / тень', en: 'Outline / shadow', uk: 'Обведення / тінь', be: 'Абвядзенне / цень' },
            subs_plus_edge_color: { ru: 'Цвет обрамления', en: 'Outline colour', uk: 'Колір обведення', be: 'Колер абвядзення' },
            subs_plus_reset: { ru: 'Сбросить', en: 'Reset', uk: 'Скинути', be: 'Скінуць' },
            subs_plus_reset_descr: {
                ru: 'Вернуть настройки по умолчанию',
                en: 'Restore the default settings',
                uk: 'Повернути налаштування за замовчуванням',
                be: 'Вярнуць налады па змаўчанні'
            },
            subs_plus_sample: {
                ru: 'Пример субтитров<br>Так будет выглядеть текст',
                en: 'Subtitle sample<br>This is how the text will look',
                uk: 'Приклад субтитрів<br>Так виглядатиме текст',
                be: 'Прыклад субтытраў<br>Так будзе выглядаць тэкст'
            },
            subs_plus_none: { ru: 'Нет', en: 'None', uk: 'Немає', be: 'Няма' },
            subs_plus_color_white: { ru: 'Белый', en: 'White', uk: 'Білий', be: 'Белы' },
            subs_plus_color_yellow: { ru: 'Жёлтый', en: 'Yellow', uk: 'Жовтий', be: 'Жоўты' },
            subs_plus_color_green: { ru: 'Зелёный', en: 'Green', uk: 'Зелений', be: 'Зялёны' },
            subs_plus_color_cyan: { ru: 'Голубой', en: 'Cyan', uk: 'Блакитний', be: 'Блакітны' },
            subs_plus_color_blue: { ru: 'Синий', en: 'Blue', uk: 'Синій', be: 'Сіні' },
            subs_plus_color_red: { ru: 'Красный', en: 'Red', uk: 'Червоний', be: 'Чырвоны' },
            subs_plus_color_magenta: { ru: 'Пурпурный', en: 'Magenta', uk: 'Пурпуровий', be: 'Пурпурны' },
            subs_plus_color_gray: { ru: 'Серый', en: 'Grey', uk: 'Сірий', be: 'Шэры' },
            subs_plus_color_black: { ru: 'Чёрный', en: 'Black', uk: 'Чорний', be: 'Чорны' },
            subs_plus_vertical_bottom: { ru: 'Снизу', en: 'Bottom', uk: 'Знизу', be: 'Знізу' },
            subs_plus_vertical_middle: { ru: 'Посередине', en: 'Middle', uk: 'Посередині', be: 'Пасярэдзіне' },
            subs_plus_vertical_top: { ru: 'Сверху', en: 'Top', uk: 'Зверху', be: 'Зверху' },
            subs_plus_horizontal_left: { ru: 'Слева', en: 'Left', uk: 'Ліворуч', be: 'Злева' },
            subs_plus_horizontal_center: { ru: 'По центру', en: 'Centre', uk: 'По центру', be: 'Па цэнтры' },
            subs_plus_horizontal_right: { ru: 'Справа', en: 'Right', uk: 'Праворуч', be: 'Справа' },
            subs_plus_bg_black: { ru: 'Чёрная', en: 'Black', uk: 'Чорна', be: 'Чорная' },
            subs_plus_bg_gray: { ru: 'Серая', en: 'Grey', uk: 'Сіра', be: 'Шэрая' },
            subs_plus_bg_white: { ru: 'Белая', en: 'White', uk: 'Біла', be: 'Белая' },
            subs_plus_bg_blue: { ru: 'Синяя', en: 'Blue', uk: 'Синя', be: 'Сіняя' },
            subs_plus_edge_outline: { ru: 'Тонкий контур', en: 'Thin outline', uk: 'Тонкий контур', be: 'Тонкі контур' },
            subs_plus_edge_outline_thick: { ru: 'Толстый контур', en: 'Thick outline', uk: 'Товстий контур', be: 'Тоўсты контур' },
            subs_plus_edge_shadow: { ru: 'Тень', en: 'Drop shadow', uk: 'Тінь', be: 'Цень' },
            subs_plus_edge_raised: { ru: 'Приподнятый', en: 'Raised', uk: 'Піднятий', be: 'Узняты' },
            subs_plus_edge_depressed: { ru: 'Утопленный', en: 'Depressed', uk: 'Утоплений', be: 'Утоплены' },
            subs_plus_edge_glow: { ru: 'Свечение', en: 'Glow', uk: 'Світіння', be: 'Свячэнне' }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Start                                                               */
    /* ------------------------------------------------------------------ */

    function stripQuery(url) {
        return String(url).split(/[?#]/)[0];
    }

    function isOwnUrl(url) {
        if (SCRIPT_SRC && stripQuery(SCRIPT_SRC) === stripQuery(url)) return true;

        return FILE_PATTERN.test(url);
    }

    function isOwnTitle(name) {
        for (var lang in TITLE) {
            if (TITLE.hasOwnProperty(lang) && TITLE[lang] === name) return true;
        }

        return false;
    }

    /**
     * Lampa shows a plugin added by URL as "No name": its entry in `plugins` is just {url, status}.
     * Fill in the name (in the current language) and the author of our entry in Settings → Extensions.
     * A name the user set by hand is kept.
     */
    function nameSelf() {
        try {
            if (!Lampa.Plugins || typeof Lampa.Plugins.get !== 'function' || typeof Lampa.Plugins.save !== 'function') return;

            var list = Lampa.Plugins.get();
            var title = t('subs_plus_title');
            var changed = false;

            for (var i = 0; i < list.length; i++) {
                var item = list[i];

                if (!item || typeof item !== 'object' || !item.url || !isOwnUrl(item.url)) continue;

                if ((!item.name || isOwnTitle(item.name)) && item.name !== title) {
                    item.name = title;
                    changed = true;
                }

                if (!item.author) {
                    item.author = AUTHOR;
                    changed = true;
                }
            }

            if (changed) Lampa.Plugins.save();
        } catch (e) {
            log('cannot name the extension entry', e);
        }
    }

    function onStorageChange(e) {
        if (e && typeof e.name === 'string' && e.name.indexOf(PREFIX) === 0) applyState();
    }

    function onReady() {
        nameSelf();
        applyState();

        Lampa.Select.listener.follow('preshow', onSelectPreshow);
        Lampa.Select.listener.follow('hide', checkPreview);
        Lampa.Select.listener.follow('close', checkPreview);

        if (Lampa.Storage.listener) Lampa.Storage.listener.follow('change', onStorageChange);

        Lampa.Player.listener.follow('ready', start);
        Lampa.Player.listener.follow('destroy', function () {
            override = null;
            setPreview(false);
            stop();
        });
    }

    function startPlugin() {
        window.plugin_subs_plus_ready = true;

        log('version', VERSION);

        addTranslations();

        Lampa.Manifest.plugins = {
            type: 'other',
            version: VERSION,
            name: t('subs_plus_title'),
            description: 'Own subtitle layer in the built-in player: size, colour, opacity, position, delay, backdrop, outline',
            component: 'subs_plus'
        };

        if (window.appready) onReady();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') onReady();
            });
        }
    }

    if (!window.plugin_subs_plus_ready) startPlugin();
})();
