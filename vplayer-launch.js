/**
 * "Vplayer" plugin for Lampa (webOS)
 *
 * Adds the native VPlayer app (com.sostk.vplayer, libVLC) as one more way to play media on webOS:
 *   - Settings -> Player: the "Vplayer" value in the player type of videos, IPTV and torrents;
 *   - long press on a file of a torrent: the "Launch player - Vplayer" item next to "- WebOS".
 * VPlayer is started through the application manager with its launch parameters
 * {"play": url, "at": seconds}. On other platforms the plugin does nothing.
 *
 * Plain ES5, no build step: the file is the plugin entry point.
 */
(function () {
    'use strict';

    var VERSION = '1.0.0';
    var APP_ID = 'com.sostk.vplayer';
    var VALUE = 'vplayer';
    var LABEL = 'Vplayer';
    var PARAMS = ['player', 'player_iptv', 'player_torrent'];
    var ONE_SHOT_TIMEOUT = 15000;

    var explicit = '';      // the last Lampa.Player.runas() choice, until Lampa's player is destroyed
    var oneShot = false;    // "Launch player - Vplayer" was chosen in the torrent file menu
    var oneShotTimer = 0;
    var originalRunas = null;

    function t(name) {
        return Lampa.Lang.translate(name);
    }

    function log() {
        var args = Array.prototype.slice.call(arguments);

        args.unshift('Vplayer');
        console.log.apply(console, args);
    }

    function addTranslations() {
        Lampa.Lang.add({
            vplayer_not_installed: {
                ru: 'Vplayer не установлен: установите com.sostk.vplayer из Homebrew Channel',
                en: 'Vplayer is not installed: install com.sostk.vplayer from the Homebrew Channel',
                uk: 'Vplayer не встановлено: встановіть com.sostk.vplayer з Homebrew Channel',
                be: 'Vplayer не ўсталяваны: усталюйце com.sostk.vplayer з Homebrew Channel'
            },
            vplayer_launch_error: {
                ru: 'Не удалось запустить Vplayer',
                en: 'Could not launch Vplayer',
                uk: 'Не вдалося запустити Vplayer',
                be: 'Не ўдалося запусціць Vplayer'
            },
            vplayer_no_service: {
                ru: 'Запуск Vplayer доступен только на webOS',
                en: 'Vplayer can be launched only on webOS',
                uk: 'Запуск Vplayer доступний лише на webOS',
                be: 'Запуск Vplayer даступны толькі на webOS'
            },
            vplayer_plugin: {
                ru: 'Запуск в Vplayer',
                en: 'Launch in Vplayer',
                uk: 'Запуск у Vplayer',
                be: 'Запуск у Vplayer'
            }
        });
    }

    /**
     * The "Vplayer" value in the player type selects (Lampa.Params.init may recreate them)
     */
    function addOptions() {
        var values = Lampa.Params && Lampa.Params.values;

        if (!values) return;

        for (var i = 0; i < PARAMS.length; i++) {
            var select = values[PARAMS[i]];

            if (select && typeof select === 'object' && !select[VALUE]) select[VALUE] = LABEL;
        }
    }

    function isTube(url) {
        return /youtube\.com|youtu\.be/i.test(url || '');
    }

    function launchVplayer(url, at) {
        var params = { play: url };

        if (at > 0) params.at = at;

        log('launch', url, at > 0 ? 'at ' + at : '');

        if (typeof webOS === 'undefined' || !webOS.service || !webOS.service.request) {
            Lampa.Noty.show(t('vplayer_no_service'));
            return;
        }

        webOS.service.request('luna://com.webos.applicationManager', {
            method: 'launch',
            parameters: {
                id: APP_ID,
                params: params
            },
            onSuccess: function () {
                log('launched');
            },
            onFailure: function (error) {
                var code = error && error.errorCode;
                var text = (error && error.errorText) || '';

                log('launch failed', code, text);

                if (code == -101 || /exist|not found|not installed/i.test(text)) {
                    Lampa.Noty.show(t('vplayer_not_installed'));
                } else {
                    Lampa.Noty.show(t('vplayer_launch_error') + (error && error.errorText ? ': ' + error.errorText : ''));
                }
            }
        });
    }

    function sendExternal(data) {
        try {
            Lampa.Player.listener.send('external', data);
        } catch (e) {
            log('external event failed', e && e.message);
        }
    }

    function clearOneShot() {
        oneShot = false;
        clearTimeout(oneShotTimer);
    }

    /**
     * The URL Lampa would give to an external player: the chosen quality, TorrServer's "&play"
     */
    function playUrl(data) {
        var url = data.url;

        if (data.quality && typeof data.quality === 'object' && Object.keys(data.quality).length > 1 &&
            typeof Lampa.Player.getUrlQuality === 'function') {
            url = Lampa.Player.getUrlQuality(data.quality, false) || url;
        }

        if (url && Lampa.Torserver && typeof Lampa.Torserver.toPlayUrl === 'function') {
            url = Lampa.Torserver.toPlayUrl(url);
        }

        return url;
    }

    function wanted(data) {
        if (oneShot) return true;
        if (explicit && explicit !== VALUE) return false;
        if (explicit === VALUE) return true;

        return Lampa.Storage.field(data.torrent_hash ? 'player_torrent' : 'player') === VALUE;
    }

    /**
     * Lampa.Player.play(): take the launch away from Lampa before it picks a player
     */
    function onCreate(e) {
        var data = e && e.data;

        if (!data || typeof e.abort !== 'function') return;
        // the next episode inside Lampa's own player: it is already playing there
        if (data.continue_play) return;
        if (!wanted(data)) return;

        var url = playUrl(data);

        if (!url || typeof url !== 'string' || isTube(url)) return;

        e.abort();

        var ranAs = explicit;

        clearOneShot();

        // Lampa keeps runas() until its player is closed, which never happens here
        if (ranAs && originalRunas) {
            explicit = '';
            originalRunas.call(Lampa.Player, '');
        }

        var at = data.timeline ? Math.floor(data.timeline.time || 0) : 0;

        launchVplayer(url, at);

        sendExternal(data);
    }

    function wrapRunas() {
        if (typeof Lampa.Player.runas !== 'function' || Lampa.Player.runas._vplayer) return;

        originalRunas = Lampa.Player.runas;

        var wrapped = function (need) {
            explicit = need || '';

            return originalRunas.apply(this, arguments);
        };

        wrapped._vplayer = true;

        Lampa.Player.runas = wrapped;
    }

    function wrapIptv() {
        if (typeof Lampa.Player.iptv !== 'function' || Lampa.Player.iptv._vplayer) return;

        var original = Lampa.Player.iptv;

        var wrapped = function (data) {
            if (data && typeof data.url === 'string' && data.url && Lampa.Storage.field('player_iptv') === VALUE) {
                launchVplayer(data.url, 0);
                sendExternal(data);
                return;
            }

            return original.apply(this, arguments);
        };

        wrapped._vplayer = true;

        Lampa.Player.iptv = wrapped;
    }

    /**
     * Long press on a file of a torrent: our item after "Launch player - WebOS"
     */
    function onTorrentFile(e) {
        if (!e || e.type !== 'onlong' || !e.menu || !e.item) return;

        var menu = e.menu;
        var item = e.item;
        var enabled = Lampa.Controller.enabled().name;

        for (var i = 0; i < menu.length; i++) {
            if (menu[i] && menu[i]._vplayer) return;
        }

        var entry = {
            title: t('player_lauch') + ' - ' + LABEL,
            _vplayer: true,
            onSelect: function () {
                Lampa.Controller.toggle(enabled);

                clearOneShot();
                oneShot = true;
                oneShotTimer = setTimeout(clearOneShot, ONE_SHOT_TIMEOUT);

                item.trigger('hover:enter');
            }
        };

        var index = -1;

        for (var j = 0; j < menu.length; j++) {
            if (menu[j] && menu[j].player === 'webos') index = j + 1;
        }

        if (index < 0) {
            for (var k = 0; k < menu.length; k++) {
                if (menu[k] && menu[k].player === 'lampa') {
                    index = k;
                    break;
                }
            }
        }

        if (index < 0) menu.push(entry);
        else menu.splice(index, 0, entry);
    }

    function onReady() {
        addOptions();

        wrapRunas();
        wrapIptv();

        Lampa.Player.listener.follow('create', onCreate);

        // Lampa forgets runas() when its player closes (older builds send only "destroy")
        Lampa.Player.listener.follow('destroy', function () {
            explicit = '';
        });

        Lampa.Listener.follow('torrent_file', onTorrentFile);

        if (Lampa.Settings && Lampa.Settings.listener) {
            Lampa.Settings.listener.follow('open', addOptions);
        }
    }

    function startPlugin() {
        window.plugin_vplayer_launch_ready = true;

        if (!Lampa.Platform.is('webos')) {
            log('not webOS, nothing to do');
            return;
        }

        log('version', VERSION);

        addTranslations();

        Lampa.Manifest.plugins = {
            type: 'other',
            version: VERSION,
            name: t('vplayer_plugin'),
            description: 'Adds Vplayer (com.sostk.vplayer) to the player choice on webOS: settings and torrent file menu',
            component: 'vplayer_launch'
        };

        if (window.appready) onReady();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') onReady();
            });
        }
    }

    if (!window.plugin_vplayer_launch_ready) startPlugin();
})();
