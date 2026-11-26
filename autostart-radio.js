/**
 * Radio autostart plugin for Lampa
 *
 * Adds a "Radio autostart" section to the Lampa settings. When enabled, launches the selected
 * object (provider) after the app is ready, e.g. a SomaFM radio channel.
 *
 * Other plugins can add their own autostart targets:
 *
 *   function addAutostartRadio(){
 *       Lampa.AutostartRadio.register({
 *           id: 'my_plugin',
 *           name: 'My plugin',
 *           settings: function(addParam){ addParam({ param: {...}, field: {...} }) },
 *           init: function(){},
 *           run: function(done, fail){ ...; done() },
 *           // optional, to come back after a video: see Resume
 *           active: function(){ return true }, suspend: function(){}, stop: function(){},
 *           resume: function(done, fail){ done() }
 *       })
 *   }
 *   if(window.Lampa && Lampa.AutostartRadio) addAutostartRadio()
 *   else document.addEventListener('lampa_autostart_radio_ready', addAutostartRadio)
 *
 * Plain ES5, no build step: the file is the plugin entry point.
 */
(function () {
    'use strict';

    var VERSION = '1.8.0';
    var COMPONENT = 'autostart_radio';
    var AUTHOR = '@etix';
    var FILE_PATTERN = /\/autostart-radio\.js(\?|#|$)/i;

    // plugin name in every language: settings section, Noty prefix and the entry in Settings → Extensions
    var TITLE = {
        ru: 'Автозапуск радио',
        en: 'Radio autostart',
        uk: 'Автозапуск радіо',
        be: 'Аўтазапуск радыё'
    };

    // src of this file; empty when Lampa runs the plugin from its cache
    var SCRIPT_SRC = '';

    try {
        SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
    } catch (e) { }
    var POLL_INTERVAL = 500;
    var WAIT_TIMEOUT = 30000;

    // user activity that restarts the idle countdown
    var IDLE_EVENTS = ['keydown', 'mousedown', 'mousemove', 'touchstart', 'wheel'];

    var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M12 2.5v8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M6.3 5.6a8.5 8.5 0 1 0 11.4 0" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '</svg>';

    var providers = [];
    var targetValues = {};
    var appReady = false;
    var settingsBuilt = false;
    var lastSettingsOpen = '';

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function t(key) {
        return Lampa.Lang.translate(key);
    }

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('AutostartRadio');
        console.log.apply(console, args);
    }

    function notify(message) {
        log('error:', message);
        try {
            Lampa.Noty.show(t('autostart_title') + ': ' + message);
        } catch (e) { }
    }

    /**
     * Poll `check()` until it returns a truthy value or the timeout expires.
     */
    function waitFor(check, timeout, done, fail) {
        var started = Date.now();

        function tick() {
            var result = null;

            try {
                result = check();
            } catch (e) { }

            if (result) return done(result);
            if (Date.now() - started >= timeout) return fail && fail();

            setTimeout(tick, POLL_INTERVAL);
        }

        tick();
    }

    function playerOpened() {
        try {
            return Lampa.Player.opened() === true;
        } catch (e) {
            return false;
        }
    }

    /** Idle time from a settings select, in seconds. */
    function idleSeconds(name) {
        return parseInt(Lampa.Storage.field(name), 10) || 0;
    }

    /**
     * Call `done()` once there was no user activity for `seconds`. The handler only stores the
     * time, a single timer checks it and waits for the rest. An open video player or a hidden
     * Lampa (external player) is activity too. Returns a function that cancels the wait.
     */
    function waitIdle(seconds, done) {
        var ms = seconds * 1000;
        var last = Date.now();
        var timer = null;
        var i;

        function touch() {
            last = Date.now();
        }

        function off() {
            clearTimeout(timer);

            for (var k = 0; k < IDLE_EVENTS.length; k++) window.removeEventListener(IDLE_EVENTS[k], touch, true);
        }

        function check() {
            if (playerOpened() || document.hidden) last = Date.now();

            var left = ms - (Date.now() - last);

            if (left > 0) {
                timer = setTimeout(check, left);
                return;
            }

            off();
            done();
        }

        if (!ms) {
            done();
            return function () { };
        }

        // capture phase: Lampa cannot stop the event before us; `true` instead of {passive} for old TV browsers
        for (i = 0; i < IDLE_EVENTS.length; i++) window.addEventListener(IDLE_EVENTS[i], touch, true);

        timer = setTimeout(check, ms);

        return off;
    }

    function storageArray(name) {
        var value = Lampa.Storage.get(name, '[]');

        if (typeof value === 'string') {
            try {
                value = JSON.parse(value);
            } catch (e) {
                value = [];
            }
        }

        return Array.isArray(value) ? value : [];
    }

    function storageObject(name) {
        var value = Lampa.Storage.get(name, '{}');

        if (typeof value === 'string') {
            try {
                value = JSON.parse(value);
            } catch (e) {
                value = {};
            }
        }

        return value && typeof value === 'object' ? value : {};
    }

    /** Replace the content of `target` with `source`, keeping the object reference. */
    function refillObject(target, source) {
        var key;

        for (key in target) {
            if (target.hasOwnProperty(key)) delete target[key];
        }

        for (key in source) {
            if (source.hasOwnProperty(key)) target[key] = source[key];
        }
    }

    function isSettingsOpen(name) {
        try {
            return lastSettingsOpen === name && Lampa.Controller.enabled().name === 'settings_component';
        } catch (e) {
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Translations                                                        */
    /* ------------------------------------------------------------------ */

    function addTranslations() {
        Lampa.Lang.add({
            autostart_title: TITLE,
            autostart_enabled: {
                ru: 'Автозапуск при старте',
                en: 'Autostart on launch',
                uk: 'Автозапуск під час старту',
                be: 'Аўтазапуск пры старце'
            },
            autostart_enabled_descr: {
                ru: 'Запускать выбранный объект после загрузки Lampa',
                en: 'Launch the selected object after Lampa has loaded',
                uk: 'Запускати вибраний об\'єкт після завантаження Lampa',
                be: 'Запускаць выбраны аб\'ект пасля загрузкі Lampa'
            },
            autostart_target: {
                ru: 'Что запускать',
                en: 'What to launch',
                uk: 'Що запускати',
                be: 'Што запускаць'
            },
            autostart_delay: {
                ru: 'Задержка запуска',
                en: 'Launch delay',
                uk: 'Затримка запуску',
                be: 'Затрымка запуску'
            },
            autostart_delay_none: {
                ru: 'Без задержки',
                en: 'No delay',
                uk: 'Без затримки',
                be: 'Без затрымкі'
            },
            autostart_delay_sec: {
                ru: 'сек',
                en: 'sec',
                uk: 'сек',
                be: 'сек'
            },
            autostart_delay_min: {
                ru: 'мин',
                en: 'min',
                uk: 'хв',
                be: 'хв'
            },
            autostart_idle: {
                ru: 'Запускать при простое',
                en: 'Launch when idle',
                uk: 'Запускати під час простою',
                be: 'Запускаць пры прастоі'
            },
            autostart_resume_idle: {
                ru: 'Продолжать при простое',
                en: 'Resume when idle',
                uk: 'Продовжувати під час простою',
                be: 'Працягваць пры прастоі'
            },
            autostart_idle_descr: {
                ru: 'Отсчёт начинается заново при нажатии кнопок, движении мыши или касании',
                en: 'The countdown restarts on a key press, mouse movement or touch',
                uk: 'Відлік починається знову після натискання кнопок, руху миші або дотику',
                be: 'Адлік пачынаецца нанова пры націсканні кнопак, руху мышы або дотыку'
            },
            autostart_idle_none: {
                ru: 'Немедленно',
                en: 'Immediately',
                uk: 'Негайно',
                be: 'Неадкладна'
            },
            autostart_resume_video: {
                ru: 'После просмотра видео',
                en: 'After watching a video',
                uk: 'Після перегляду відео',
                be: 'Пасля прагляду відэа'
            },
            autostart_resume_video_descr: {
                ru: 'На время видео радио останавливается, в том числе во внешнем плеере',
                en: 'The radio stops while a video plays, including in an external player',
                uk: 'Під час відео радіо зупиняється, зокрема в зовнішньому плеєрі',
                be: 'На час відэа радыё спыняецца, у тым ліку ў знешнім плэеры'
            },
            autostart_resume_play: {
                ru: 'Продолжить воспроизведение',
                en: 'Resume playback',
                uk: 'Продовжити відтворення',
                be: 'Працягнуць прайграванне'
            },
            autostart_resume_none: {
                ru: 'Ничего не делать',
                en: 'Do nothing',
                uk: 'Нічого не робити',
                be: 'Нічога не рабіць'
            },
            autostart_error_provider: {
                ru: 'объект автозапуска не найден',
                en: 'autostart target not found',
                uk: 'об\'єкт автозапуску не знайдено',
                be: 'аб\'ект аўтазапуску не знойдзены'
            },
            autostart_radio_channel: {
                ru: 'Канал',
                en: 'Channel',
                uk: 'Канал',
                be: 'Канал'
            },
            autostart_radio_channel_descr: {
                ru: 'Канал играет в фоне, мини-плеер появится в шапке',
                en: 'The channel plays in the background, the mini player appears in the header',
                uk: 'Канал грає у фоні, мініплеєр з\'явиться в шапці',
                be: 'Канал грае ў фоне, міні-плэер з\'явіцца ў шапцы'
            },
            autostart_radio_mode: {
                ru: 'Режим при старте',
                en: 'Start mode',
                uk: 'Режим під час старту',
                be: 'Рэжым пры старце'
            },
            autostart_radio_mode_descr: {
                ru: 'При паузе канал запустится по нажатию на иконку {name} в шапке',
                en: 'When paused, the channel starts when you press the {name} icon in the header',
                uk: 'На паузі канал запуститься після натискання на іконку {name} у шапці',
                be: 'На паўзе канал запусціцца пасля націскання на іконку {name} у шапцы'
            },
            autostart_radio_mode_play: {
                ru: 'Играть',
                en: 'Play',
                uk: 'Грати',
                be: 'Іграць'
            },
            autostart_radio_mode_pause: {
                ru: 'Пауза (только иконка в шапке)',
                en: 'Paused (header icon only)',
                uk: 'Пауза (лише іконка в шапці)',
                be: 'Паўза (толькі іконка ў шапцы)'
            },
            autostart_radio_last: {
                ru: 'Последний прослушанный',
                en: 'Last played',
                uk: 'Останній прослуханий',
                be: 'Апошні праслуханы'
            },
            autostart_radio_error_plugin: {
                ru: 'плагин {name} не найден',
                en: '{name} plugin not found',
                uk: 'плагін {name} не знайдено',
                be: 'плагін {name} не знойдзены'
            },
            autostart_radio_error_last: {
                ru: 'нет последнего прослушанного канала {name}',
                en: 'no last played {name} channel',
                uk: 'немає останнього прослуханого каналу {name}',
                be: 'няма апошняга праслуханага канала {name}'
            },
            autostart_radio_error_list: {
                ru: 'не удалось загрузить список каналов {name}',
                en: 'failed to load the {name} channel list',
                uk: 'не вдалося завантажити список каналів {name}',
                be: 'не ўдалося загрузіць спіс каналаў {name}'
            },
            autostart_radio_error_channel: {
                ru: 'канал {name} не найден',
                en: '{name} channel not found',
                uk: 'канал {name} не знайдено',
                be: 'канал {name} не знойдзены'
            },
            autostart_radio_plugin_ok: {
                ru: 'Плагин {name}: установлен',
                en: '{name} plugin: installed',
                uk: 'Плагін {name}: встановлено',
                be: 'Плагін {name}: усталяваны'
            },
            autostart_radio_plugin_disabled: {
                ru: 'Плагин {name}: выключен',
                en: '{name} plugin: disabled',
                uk: 'Плагін {name}: вимкнено',
                be: 'Плагін {name}: выключаны'
            },
            autostart_radio_plugin_disabled_descr: {
                ru: 'Включите его в Настройки → Расширения',
                en: 'Enable it in Settings → Extensions',
                uk: 'Увімкніть його в Налаштування → Розширення',
                be: 'Уключыце яго ў Налады → Пашырэнні'
            },
            autostart_radio_plugin_missing: {
                ru: 'Плагин {name}: не установлен',
                en: '{name} plugin: not installed',
                uk: 'Плагін {name}: не встановлено',
                be: 'Плагін {name}: не ўсталяваны'
            },
            autostart_radio_plugin_missing_descr: {
                ru: 'Добавьте в Настройки → Расширения: {url}',
                en: 'Add it in Settings → Extensions: {url}',
                uk: 'Додайте в Налаштування → Розширення: {url}',
                be: 'Дадайце ў Налады → Пашырэнні: {url}'
            },
            autostart_radio_need_plugin: {
                ru: 'для автозапуска нужен плагин {name}: {url}',
                en: 'autostart needs the {name} plugin: {url}',
                uk: 'для автозапуску потрібен плагін {name}: {url}',
                be: 'для аўтазапуску патрэбны плагін {name}: {url}'
            },
            autostart_radio_plugin_off: {
                ru: 'плагин {name} выключен в Настройки → Расширения',
                en: 'the {name} plugin is disabled in Settings → Extensions',
                uk: 'плагін {name} вимкнено в Налаштування → Розширення',
                be: 'плагін {name} выключаны ў Налады → Пашырэнні'
            },
            autostart_custom_title: {
                ru: 'Свой поток',
                en: 'Custom stream',
                uk: 'Свій потік',
                be: 'Свой паток'
            },
            autostart_custom_name: {
                ru: 'Название',
                en: 'Name',
                uk: 'Назва',
                be: 'Назва'
            },
            autostart_custom_name_descr: {
                ru: 'Показывается у иконки радио в шапке',
                en: 'Shown next to the radio icon in the header',
                uk: 'Показується біля іконки радіо в шапці',
                be: 'Паказваецца каля іконкі радыё ў шапцы'
            },
            autostart_custom_name_default: {
                ru: 'Моё радио',
                en: 'My radio',
                uk: 'Моє радіо',
                be: 'Маё радыё'
            },
            autostart_custom_url: {
                ru: 'Адрес потока',
                en: 'Stream URL',
                uk: 'Адреса потоку',
                be: 'Адрас патоку'
            },
            autostart_custom_url_descr: {
                ru: 'Прямой поток mp3/aac, плейлист .pls/.m3u или HLS .m3u8 (если его поддерживает устройство)',
                en: 'Direct mp3/aac stream, .pls/.m3u playlist or HLS .m3u8 (if the device supports it)',
                uk: 'Прямий потік mp3/aac, плейлист .pls/.m3u або HLS .m3u8 (якщо його підтримує пристрій)',
                be: 'Прамы паток mp3/aac, плэйліст .pls/.m3u або HLS .m3u8 (калі яго падтрымлівае прылада)'
            },
            autostart_custom_volume: {
                ru: 'Громкость',
                en: 'Volume',
                uk: 'Гучність',
                be: 'Гучнасць'
            },
            autostart_custom_volume_descr: {
                ru: 'Громкость встроенного плеера, до неё же растёт плавное нарастание',
                en: 'Volume of the built-in player, the fade-in also rises to it',
                uk: 'Гучність вбудованого плеєра, до неї ж зростає плавне наростання',
                be: 'Гучнасць убудаванага плэера, да яе ж расце плаўнае нарастанне'
            },
            autostart_custom_fade: {
                ru: 'Плавное нарастание громкости',
                en: 'Volume fade-in',
                uk: 'Плавне наростання гучності',
                be: 'Плаўнае нарастанне гучнасці'
            },
            autostart_custom_fade_descr: {
                ru: 'При автозапуске и после просмотра видео',
                en: 'On autostart and after watching a video',
                uk: 'Під час автозапуску та після перегляду відео',
                be: 'Пры аўтазапуску і пасля прагляду відэа'
            },
            autostart_custom_fade_none: {
                ru: 'Выкл',
                en: 'Off',
                uk: 'Вимк',
                be: 'Выкл'
            },
            autostart_custom_error_url: {
                ru: 'укажите адрес потока (http:// или https://) в Настройки → Автозапуск радио',
                en: 'set the stream URL (http:// or https://) in Settings → Radio autostart',
                uk: 'вкажіть адресу потоку (http:// або https://) у Налаштування → Автозапуск радіо',
                be: 'пазначце адрас патоку (http:// або https://) у Налады → Аўтазапуск радыё'
            },
            autostart_custom_error_play: {
                ru: 'не удалось воспроизвести поток {url}',
                en: 'failed to play the stream {url}',
                uk: 'не вдалося відтворити потік {url}',
                be: 'не ўдалося прайграць паток {url}'
            },
            autostart_radio_error_stream: {
                ru: 'не удалось получить поток канала {name}',
                en: 'failed to get the {name} channel stream',
                uk: 'не вдалося отримати потік каналу {name}',
                be: 'не ўдалося атрымаць паток канала {name}'
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Provider registry                                                   */
    /* ------------------------------------------------------------------ */

    function findProvider(id) {
        for (var i = 0; i < providers.length; i++) {
            if (providers[i].id === id) return providers[i];
        }

        return null;
    }

    /** The provider that plays now. */
    function activeProvider() {
        for (var i = 0; i < providers.length; i++) {
            var provider = providers[i];

            if (typeof provider.active !== 'function') continue;

            try {
                if (provider.active()) return provider;
            } catch (e) { }
        }

        return null;
    }

    /**
     * Add a provider parameter to the settings section. It is shown only
     * while this provider is selected in "What to launch".
     */
    function addProviderParam(provider, data) {
        var userRender = data.onRender;

        data.component = COMPONENT;
        data.onRender = function (item) {
            item.attr('data-parent', 'autostart_target');
            item.attr('data-visible-value', provider.id);

            if (typeof userRender === 'function') userRender(item);
        };

        Lampa.SettingsApi.addParam(data);
    }

    function addProviderSettings(provider) {
        if (typeof provider.settings !== 'function') return;

        addProviderParam(provider, {
            param: { type: 'title' },
            field: { name: provider.name }
        });

        try {
            provider.settings(function (data) {
                addProviderParam(provider, data);
            });
        } catch (e) {
            log('provider settings error', provider.id, e);
        }
    }

    function initProvider(provider) {
        if (provider._autostart_inited || typeof provider.init !== 'function') return;

        provider._autostart_inited = true;

        try {
            provider.init();
        } catch (e) {
            log('provider init error', provider.id, e);
        }
    }

    /**
     * Register an autostart provider.
     * @param {{id:string, name:string, run:function(function, function), settings?:function(function), init?:function}} provider
     * @returns {boolean}
     */
    function register(provider) {
        if (!provider || typeof provider.id !== 'string' || typeof provider.run !== 'function') {
            log('invalid provider', provider);
            return false;
        }

        if (provider.id === 'none' || findProvider(provider.id)) {
            log('provider already registered', provider.id);
            return false;
        }

        provider.name = provider.name || provider.id;

        providers.push(provider);

        targetValues[provider.id] = provider.name;

        if (settingsBuilt) addProviderSettings(provider);
        if (appReady) initProvider(provider);

        log('provider registered', provider.id);

        return true;
    }

    /* ------------------------------------------------------------------ */
    /* Settings                                                            */
    /* ------------------------------------------------------------------ */

    function buildSettings() {
        var delays = [0, 3, 5, 10, 15, 30];
        var delayValues = {};
        var idles = [0, 30, 60, 180, 300, 600, 1200, 1800, 3600];
        var idleValues = {};

        // 1.7.0 and earlier had "Nothing" in "What to launch": keep nothing launching, the switch does it now
        if (Lampa.Storage.get('autostart_target', '') === 'none') {
            Lampa.Storage.set('autostart_target', 'custom', true);
            Lampa.Storage.set('autostart_enabled', false, true);
            log('target "none" replaced by "custom", autostart turned off');
        }

        for (var i = 0; i < delays.length; i++) {
            delayValues[delays[i]] = delays[i] ? delays[i] + ' ' + t('autostart_delay_sec') : t('autostart_delay_none');
        }

        for (var j = 0; j < idles.length; j++) {
            var idle = idles[j];

            if (!idle) idleValues[idle] = t('autostart_idle_none');
            else if (idle < 60) idleValues[idle] = idle + ' ' + t('autostart_delay_sec');
            else idleValues[idle] = idle / 60 + ' ' + t('autostart_delay_min');
        }

        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name: t('autostart_title'),
            icon: ICON
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: 'autostart_enabled',
                type: 'trigger',
                default: false
            },
            field: {
                name: t('autostart_enabled'),
                description: t('autostart_enabled_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: 'autostart_target',
                type: 'select',
                values: targetValues,
                default: 'custom'
            },
            field: {
                name: t('autostart_target')
            },
            onRender: function (item) {
                item.attr('data-children', 'autostart_target');
            }
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: 'autostart_delay',
                type: 'select',
                values: delayValues,
                default: '3'
            },
            field: {
                name: t('autostart_delay')
            }
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: 'autostart_idle',
                type: 'select',
                values: idleValues,
                default: '0'
            },
            field: {
                name: t('autostart_idle'),
                description: t('autostart_idle_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: 'autostart_resume_video',
                type: 'select',
                values: {
                    none: '#{autostart_resume_none}',
                    resume: '#{autostart_resume_play}'
                },
                default: 'none'
            },
            field: {
                name: t('autostart_resume_video'),
                description: t('autostart_resume_video_descr')
            },
            onRender: function (item) {
                item.attr('data-children', 'autostart_resume_video');
            }
        });

        // shown only with "Resume playback"
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: {
                name: 'autostart_resume_idle',
                type: 'select',
                values: idleValues,
                default: '0'
            },
            field: {
                name: t('autostart_resume_idle'),
                description: t('autostart_idle_descr')
            },
            onRender: function (item) {
                item.attr('data-parent', 'autostart_resume_video');
                item.attr('data-visible-value', 'resume');
            }
        });

        Lampa.Settings.listener.follow('open', function (e) {
            lastSettingsOpen = e.name;
        });

        settingsBuilt = true;

        for (var p = 0; p < providers.length; p++) addProviderSettings(providers[p]);
    }

    /* ------------------------------------------------------------------ */
    /* Launch                                                              */
    /* ------------------------------------------------------------------ */

    function runProvider(provider) {
        log('run', provider.id);

        // the provider can report a missing dependency right away instead of waiting for it
        if (typeof provider.check === 'function') {
            var problem = null;

            try {
                problem = provider.check();
            } catch (e) { }

            if (problem) return notify(problem);
        }

        try {
            provider.run(function () {
                log('started', provider.id);
            }, function (message) {
                notify(message || provider.name);
            });
        } catch (e) {
            notify(provider.name + ': ' + e.message);
        }
    }

    function launch() {
        if (Lampa.Storage.field('autostart_enabled') !== true) return;

        var target = Lampa.Storage.field('autostart_target');

        if (!target || target === 'none') return;

        var delay = parseInt(Lampa.Storage.field('autostart_delay'), 10) || 0;
        var idle = idleSeconds('autostart_idle');

        log('launch', target, 'in', delay, 'sec, idle', idle, 'sec');

        setTimeout(function () {
            waitIdle(idle, function () {
                // the user has started a radio by hand meanwhile
                var playing = activeProvider();

                if (playing) return log('launch skipped,', playing.id, 'is playing');

                // the provider can be registered later by another (slower) plugin
                waitFor(function () {
                    return findProvider(target);
                }, WAIT_TIMEOUT, runProvider, function () {
                    notify(t('autostart_error_provider') + ' (' + target + ')');
                });
            });
        }, delay * 1000);
    }

    function onReady() {
        if (appReady) return;

        appReady = true;

        buildSettings();

        for (var i = 0; i < providers.length; i++) initProvider(providers[i]);

        Resume.init();

        launch();
    }

    /* ------------------------------------------------------------------ */
    /* Radio providers                                                     */
    /* SomaFM and Radio Record plugins share the same design: a global    */
    /* player with play(station), a header mini player button and an     */
    /* optional fullscreen info screen.                                    */
    /* ------------------------------------------------------------------ */

    function radioText(key, name, url) {
        return t(key).replace('{name}', name).replace('{url}', url || '');
    }

    /**
     * Select option key of a channel id. Integer-like keys are always iterated in numeric
     * order, which breaks the alphabetical order of the list (Radio Record ids are numbers),
     * so they get a prefix.
     */
    function optionKey(id) {
        id = String(id);

        return /^\d+$/.test(id) ? 'id' + id : id;
    }

    function optionId(key) {
        key = String(key || '');

        return /^id\d+$/.test(key) ? key.slice(2) : key;
    }

    /**
     * State of a radio plugin from the Lampa extension list (`plugins`: [{url, status}]):
     * loaded, installed (enabled, still loading), disabled or missing.
     */
    function pluginState(cfg) {
        try {
            if (cfg.player()) return 'loaded';
        } catch (e) { }

        var list = storageArray('plugins');
        var state = 'missing';

        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var url = typeof item === 'string' ? item : item && item.url;

            if (!url || !cfg.plugin.match.test(url)) continue;

            // an enabled copy wins over a disabled one
            if (typeof item === 'object' && item.status === 0) state = 'disabled';
            else return 'installed';
        }

        return state;
    }

    function readRaw(name) {
        try {
            return window.localStorage.getItem(name);
        } catch (e) {
            return null;
        }
    }

    function restoreRaw(name, raw) {
        if (raw === null) {
            // an empty value makes Lampa.Storage fall back to the default, then drop the key
            Lampa.Storage.set(name, '', true);

            try {
                window.localStorage.removeItem(name);
            } catch (e) { }
        } else {
            Lampa.Storage.set(name, raw, true);
        }
    }

    /**
     * Close an info overlay that opened anyway: its "back" handler loops and the UI stays
     * hidden when the plugin activity was never opened.
     */
    function dismissOverlay(selector, name) {
        var overlay = selector ? document.querySelector(selector) : null;

        if (!overlay) return;

        log(name, 'info overlay forced, dismissed');

        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);

        document.body.classList.remove('ambience--enable');

        try {
            var active = Lampa.Activity.active();

            if (active && active.activity) active.activity.toggle();
            else Lampa.Controller.toggle('head');
        } catch (e) {
            try {
                Lampa.Controller.toggle('head');
            } catch (err) { }
        }
    }

    /**
     * Create an autostart provider for a radio plugin.
     *
     * cfg.id, cfg.name      provider id and title
     * cfg.key               settings prefix: autostart_<key>_channel|mode|last|channels
     * cfg.player()          the plugin player or null
     * cfg.plugin            {match, url}: how to find the plugin in the Lampa extension list
     * cfg.fetchList(d, f)   load the raw channel list
     * cfg.channel(raw)      {id, title} of a raw channel, or null to skip it
     * cfg.station(raw, d, f) build the station object for player.play()
     * cfg.image(station)    image for the header button in pause mode
     * cfg.button            {root, name, icon} selectors of the header button
     * cfg.overlay           selector of the info overlay
     * cfg.infoKeys          settings that open the info overlay (turned off while starting)
     * cfg.offTriggers       also answer false for every enabled setting read while starting
     *                       (for plugins whose setting names are unknown)
     * cfg.hooks             player methods after which player.currentStation (or the argument)
     *                       is remembered as the last played channel
     */
    function RadioProvider(cfg) {
        var CACHE_TTL = 10 * 60 * 1000;
        var KEY = 'autostart_' + cfg.key;

        var channelValues = { last: '#{autostart_radio_last}' };
        var raws = null;
        var fetchedAt = 0;
        var pending = [];
        var armed = null;

        function error(key) {
            return radioText(key, cfg.name);
        }

        /** Rebuild the select values from a [{id, title}] list. */
        function applyList(list) {
            var values = { last: '#{autostart_radio_last}' };

            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].id) values[optionKey(list[i].id)] = list[i].title || list[i].id;
            }

            refillObject(channelValues, values);
        }

        function storeList(source) {
            var list = [];

            for (var i = 0; i < source.length; i++) {
                var channel = null;

                try {
                    channel = cfg.channel(source[i]);
                } catch (e) { }

                if (channel && channel.id) list.push({ id: String(channel.id), title: String(channel.title || channel.id) });
            }

            list.sort(function (a, b) {
                var x = a.title.toLowerCase();
                var y = b.title.toLowerCase();

                if (typeof x.localeCompare === 'function') return x.localeCompare(y);

                return x < y ? -1 : x > y ? 1 : 0;
            });

            var before = JSON.stringify(storageArray(KEY + '_channels'));
            var after = JSON.stringify(list);

            if (before === after) return false;

            Lampa.Storage.set(KEY + '_channels', list, true);

            applyList(list);

            return true;
        }

        /** Load the channel list (cached in memory), callbacks are queued while a request is in flight. */
        function fetchChannels(done, fail) {
            if (raws && Date.now() - fetchedAt < CACHE_TTL) return done(raws);

            pending.push({ done: done, fail: fail });

            if (pending.length > 1) return;

            function finish(list) {
                var queue = pending;

                pending = [];

                for (var i = 0; i < queue.length; i++) {
                    if (list) queue[i].done(list);
                    else if (queue[i].fail) queue[i].fail();
                }
            }

            cfg.fetchList(function (list) {
                if (!Array.isArray(list)) return finish(null);

                raws = list;
                fetchedAt = Date.now();

                if (storeList(list) && isSettingsOpen(COMPONENT)) Lampa.Settings.update();

                finish(list);
            }, function () {
                finish(null);
            });
        }

        function remember(station) {
            try {
                var channel = station && cfg.channel(station);

                if (channel && channel.id) {
                    Lampa.Storage.set(KEY + '_last', {
                        id: String(channel.id),
                        title: String(channel.title || channel.id)
                    }, true);
                }
            } catch (e) { }
        }

        /** Remember the channel every time the plugin starts playing something. */
        function hookPlayer(p) {
            if (p['_autostart_hooked_' + cfg.id]) return;

            p['_autostart_hooked_' + cfg.id] = true;

            for (var i = 0; i < cfg.hooks.length; i++) {
                (function (method) {
                    var original = p[method];

                    if (typeof original !== 'function') return;

                    p[method] = function (arg) {
                        // a channel started in any way replaces the one waiting in pause mode
                        if (method === 'play') armed = null;

                        var result = original.apply(this, arguments);

                        remember(p.currentStation || (arg && typeof arg === 'object' ? arg : null));

                        return result;
                    };
                })(cfg.hooks[i]);
            }
        }

        /** Play in background: the info overlay settings are off while play() runs. */
        function playInBackground(p, station) {
            var storage = Lampa.Storage;
            var field = storage.field;
            var keys = cfg.infoKeys || [];
            var saved = {};
            var turnedOff = [];
            var i;

            for (i = 0; i < keys.length; i++) {
                saved[keys[i]] = readRaw(keys[i]);
                storage.set(keys[i], false, true);
            }

            try {
                // some Lampa builds read settings from a cache, so answer for the field directly
                try {
                    storage.field = function (name) {
                        if (keys.indexOf(name) !== -1) return false;

                        var value = field.apply(this, arguments);

                        if (cfg.offTriggers && (value === true || value === 'true')) {
                            turnedOff.push(name);
                            return false;
                        }

                        return value;
                    };
                } catch (e) { }

                p.play(station);
            } finally {
                storage.field = field;

                for (i = 0; i < keys.length; i++) restoreRaw(keys[i], saved[keys[i]]);
            }

            if (turnedOff.length) log(cfg.name, 'settings off while starting:', turnedOff.join(', '));

            setTimeout(function () {
                dismissOverlay(cfg.overlay, cfg.name);
            }, 0);
        }

        function onArmedEnter() {
            if (!armed) return;

            var target = armed;

            armed = null;

            log(cfg.name, 'paused channel started');

            playInBackground(target.player, target.station);
        }

        /**
         * Pause mode: show the header button in the "stopped" state without starting the
         * audio. The plugin ignores the button until it has a stream, so the first press
         * starts the channel from here, then the plugin handles play/stop itself.
         */
        function armStation(p, station) {
            var button = document.querySelector(cfg.button.root);

            if (!button) return false;

            armed = { player: p, station: station };

            button.classList.remove('hide');
            button.classList.remove('loading');
            button.classList.add('stop');

            var name = button.querySelector(cfg.button.name);
            var channel = cfg.channel(station);

            if (name && channel) name.textContent = channel.title || '';

            var icon = button.querySelector(cfg.button.icon);
            var image = cfg.image(station);

            if (icon && image) {
                icon.style.backgroundImage = 'url(\'' + image + '\')';
                icon.style.backgroundSize = 'cover';
                icon.style.backgroundPosition = 'center';
            }

            if (!button['_autostart_armed_' + cfg.id]) {
                button['_autostart_armed_' + cfg.id] = true;

                $(button).on('hover:enter', onArmedEnter);
            }

            return true;
        }

        function resolveStation(channelId, done, fail) {
            fetchChannels(function (list) {
                var raw = null;

                for (var i = 0; i < list.length; i++) {
                    var channel = null;

                    try {
                        channel = cfg.channel(list[i]);
                    } catch (e) { }

                    if (channel && String(channel.id) === String(channelId)) raw = list[i];
                }

                if (!raw) return fail(error('autostart_radio_error_channel') + ' (' + channelId + ')');

                cfg.station(raw, done, function () {
                    fail(error('autostart_radio_error_stream'));
                });
            }, function () {
                fail(error('autostart_radio_error_list'));
            });
        }

        /** Start a channel: mode 'play' plays it in background, 'pause' only shows the header button. */
        function startChannel(channelId, mode, done, fail) {
            waitFor(cfg.player, WAIT_TIMEOUT, function (p) {
                hookPlayer(p);

                resolveStation(channelId, function (station) {
                    if (mode === 'pause') {
                        if (!armStation(p, station)) return fail(error('autostart_radio_error_plugin'));

                        return done();
                    }

                    playInBackground(p, station);

                    done();
                }, fail);
            }, function () {
                fail(error('autostart_radio_error_plugin'));
            });
        }

        return {
            id: cfg.id,
            name: cfg.name,

            check: function () {
                var state = pluginState(cfg);

                if (state === 'missing') return radioText('autostart_radio_need_plugin', cfg.name, cfg.plugin.url);
                if (state === 'disabled') return radioText('autostart_radio_plugin_off', cfg.name);

                return null;
            },

            settings: function (addParam) {
                applyList(storageArray(KEY + '_channels'));

                // 1.3.0 and earlier saved numeric ids as is
                var current = Lampa.Storage.get(KEY + '_channel', '');

                if (/^\d+$/.test(String(current))) Lampa.Storage.set(KEY + '_channel', optionKey(current), true);

                // plugin status, refreshed every time the section is rendered
                addParam({
                    param: {
                        name: KEY + '_plugin',
                        type: 'static'
                    },
                    field: {
                        name: cfg.name
                    },
                    onRender: function (item) {
                        var state = pluginState(cfg);
                        var title = 'autostart_radio_plugin_ok';
                        var descr = '';

                        if (state === 'disabled') {
                            title = 'autostart_radio_plugin_disabled';
                            descr = radioText('autostart_radio_plugin_disabled_descr', cfg.name);
                        } else if (state === 'missing') {
                            title = 'autostart_radio_plugin_missing';
                            descr = radioText('autostart_radio_plugin_missing_descr', cfg.name, cfg.plugin.url);
                        }

                        item.find('.settings-param__name').text(radioText(title, cfg.name));
                        item.find('.settings-param__descr').remove();

                        if (descr) item.append($('<div class="settings-param__descr"></div>').text(descr));
                    }
                });

                addParam({
                    param: {
                        name: KEY + '_channel',
                        type: 'select',
                        values: channelValues,
                        default: 'last'
                    },
                    field: {
                        name: t('autostart_radio_channel'),
                        description: t('autostart_radio_channel_descr')
                    }
                });

                addParam({
                    param: {
                        name: KEY + '_mode',
                        type: 'select',
                        values: {
                            play: '#{autostart_radio_mode_play}',
                            pause: '#{autostart_radio_mode_pause}'
                        },
                        default: 'play'
                    },
                    field: {
                        name: t('autostart_radio_mode'),
                        description: radioText('autostart_radio_mode_descr', cfg.name)
                    }
                });

                Lampa.Settings.listener.follow('open', function (e) {
                    if (e.name === COMPONENT) fetchChannels(function () { }, function () { });
                });
            },

            init: function () {
                fetchChannels(function () { }, function () {
                    log(cfg.name, 'channel list is not available');
                });

                waitFor(cfg.player, WAIT_TIMEOUT, hookPlayer);
            },

            run: function (done, fail) {
                var selected = Lampa.Storage.field(KEY + '_channel');
                var channelId = optionId(selected);

                if (!selected || selected === 'last') {
                    channelId = storageObject(KEY + '_last').id;

                    if (!channelId) return fail(error('autostart_radio_error_last'));
                }

                startChannel(channelId, Lampa.Storage.field(KEY + '_mode'), done, fail);
            },

            /** The header button is shown and not stopped: the user wants the radio to play. */
            active: function () {
                var button = document.querySelector(cfg.button.root);

                if (!cfg.player() || !button) return false;

                return !button.classList.contains('hide') && !button.classList.contains('stop');
            },

            /**
             * Stop for a video: destroy() stops the audio and hides the button, resume() shows it again.
             * It also resets the plugin state, otherwise play() of the same channel would be ignored.
             */
            suspend: function () {
                var p = cfg.player();

                if (p && typeof p.destroy === 'function') p.destroy();
            },

            /** Start again the channel that was playing (hooks remember every started channel). */
            resume: function (done, fail) {
                var channelId = storageObject(KEY + '_last').id;

                if (!channelId) return fail(error('autostart_radio_error_last'));

                startChannel(channelId, 'play', done, fail);
            }
        };
    }

    /** Stream urls of a .pls (FileN=...) or .m3u (plain lines) playlist. */
    function parsePlaylist(text) {
        var urls = [];
        var lines = String(text || '').split(/\r?\n/);

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            var match = line.match(/^File\d+\s*=\s*(.+)$/i);

            if (match) urls.push(match[1].trim());
            else if (/^https?:\/\//i.test(line)) urls.push(line);
        }

        return urls;
    }

    function fetchJson(url, done, fail) {
        var network = new Lampa.Reguest();

        network.timeout(15000);
        network['native'](url, done, fail);
    }

    /* ------------------------------------------------------------------ */
    /* Provider: SomaFM                                                    */
    /* https://github.com/tsynik/tsynik.github.io/blob/master/lampa/soma.js */
    /* ------------------------------------------------------------------ */

    var SomaFM = (function () {
        /** Same stream preference as soma.js */
        function pickPlaylist(channel) {
            var prefs = [
                { urlRegex: /320\.pls$/, format: 'mp3' },
                { urlRegex: /256\.pls$/, format: 'mp3' }
            ];

            if (Lampa.Storage.field('somafm_use_aac') === true) {
                prefs.push(
                    { quality: 'highest', format: 'aac' },
                    { quality: 'highest', format: 'mp3' },
                    { quality: 'high', format: 'aacp' },
                    { quality: 'low', format: 'aacp' }
                );
            } else {
                prefs.push({ quality: 'highest', format: 'mp3' });
            }

            var playlists = channel.playlists || [];

            for (var i = 0; i < prefs.length; i++) {
                for (var j = 0; j < playlists.length; j++) {
                    var pl = playlists[j];

                    if (!pl || !pl.url || pl.format !== prefs[i].format) continue;
                    if (prefs[i].urlRegex && !prefs[i].urlRegex.test(pl.url)) continue;
                    if (prefs[i].quality && pl.quality !== prefs[i].quality) continue;

                    return pl;
                }
            }

            return playlists[0] && playlists[0].url ? playlists[0] : null;
        }

        function fetchStreamUrls(playlist, done, fail) {
            var network = new Lampa.Reguest();

            network.timeout(10000);

            network['native'](playlist.url, function (text) {
                var urls = parsePlaylist(text);

                if (urls.length) done(urls);
                else fail();
            }, fail, false, {
                dataType: 'text'
            });
        }

        return RadioProvider({
            id: 'somafm',
            name: 'SomaFM',
            key: 'somafm',

            player: function () {
                var p = window.somafm_player;

                return p && typeof p.play === 'function' ? p : null;
            },

            plugin: {
                match: /\/soma\.js(\?|$)/i,
                url: 'https://tsynik.github.io/lampa/soma.js'
            },

            fetchList: function (done, fail) {
                fetchJson('https://somafm.com/channels.json', function (data) {
                    done(data && data.channels);
                }, fail);
            },

            channel: function (raw) {
                if (!raw || !raw.id) return null;
                // raw channels from channels.json have playlists, station objects have stream
                if (!Array.isArray(raw.playlists) && !raw.stream) return null;

                return { id: raw.id, title: raw.title || raw.id };
            },

            station: function (channel, done, fail) {
                var playlist = pickPlaylist(channel);

                if (!playlist) return fail();

                fetchStreamUrls(playlist, function (urls) {
                    done({
                        id: channel.id,
                        title: channel.title,
                        description: channel.description,
                        genre: (channel.genre || '').split('|').join(' ● '),
                        dj: channel.dj,
                        image: channel.image,
                        largeimage: channel.largeimage,
                        xlimage: channel.xlimage,
                        songsurl: 'https://somafm.com/songs/' + channel.id + '.json',
                        infourl: 'https://somafm.com/' + channel.id + '/',
                        stream: {
                            url: playlist.url,
                            format: playlist.format,
                            quality: playlist.quality,
                            urls: urls
                        }
                    });
                }, fail);
            },

            image: function (station) {
                return station.largeimage;
            },

            button: {
                root: '.somafm-player',
                name: '.somafm-player__name',
                icon: '.somafm-player__button'
            },
            overlay: '.somafm-info',
            infoKeys: ['somafm_show_info'],
            offTriggers: false,
            hooks: ['play']
        });
    })();

    /* ------------------------------------------------------------------ */
    /* Provider: Radio Record                                              */
    /* http://pl.bylampa.online/radio_record.js (window.radio_player),     */
    /* stations from the public Radio Record API.                          */
    /* ------------------------------------------------------------------ */

    var RadioRecord = RadioProvider({
        id: 'radiorecord',
        name: 'Radio Record',
        key: 'radiorecord',

        player: function () {
            var p = window.radio_player;

            // window.radio_player of radio_record.js: play(station), togglePlay(), move()
            return p && typeof p.play === 'function' && typeof p.togglePlay === 'function' ? p : null;
        },

        plugin: {
            match: /\/radio_record\.js(\?|$)/i,
            url: 'http://pl.bylampa.online/radio_record.js'
        },

        fetchList: function (done, fail) {
            fetchJson('https://www.radiorecord.ru/api/stations/', function (data) {
                done(data && data.result && data.result.stations);
            }, fail);
        },

        channel: function (raw) {
            if (!raw || !raw.id || !(raw.stream_320 || raw.stream_128 || raw.stream_hls)) return null;

            return { id: raw.id, title: raw.title || raw.prefix || raw.id };
        },

        // radio_record.js plays the raw station object of the API
        station: function (raw, done) {
            done(raw);
        },

        image: function (station) {
            return Lampa.Storage.field('lampaRadioRecord_icon_type') === 'gray'
                ? station.icon_gray || station.icon_fill_colored
                : station.icon_fill_colored || station.icon_gray;
        },

        button: {
            root: '.lampaRadioRecord-player',
            name: '.lampaRadioRecord-player__name',
            icon: '.lampaRadioRecord-player__button'
        },
        overlay: '.lampaRadioRecord-info',
        // the info screen setting name is obfuscated in radio_record.js
        infoKeys: [],
        offTriggers: true,
        hooks: ['play', 'move']
    });

    /* ------------------------------------------------------------------ */
    /* Provider: custom stream                                             */
    /* Any stream url played by our own mini player in the header.         */
    /* ------------------------------------------------------------------ */

    var CUSTOM_DEFAULT_URL = 'https://choco.hostingradio.ru:10010/fm';

    var CustomPlayer = (function () {
        var ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="12" cy="12" r="2.2" fill="currentColor"/>' +
            '<path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4' +
            'M18.7 5.3a9.5 9.5 0 0 1 0 13.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
            '</svg>';

        var STYLE = '' +
            '.autostart-radio{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;' +
            '-webkit-align-items:center;align-items:center;padding:0.2em 0.4em;margin:0 0.5em;border-radius:0.3em}' +
            '.autostart-radio__icon{width:2em;height:2em;display:-webkit-box;display:-webkit-flex;display:flex;' +
            '-webkit-box-align:center;-webkit-align-items:center;align-items:center;-webkit-box-pack:center;' +
            '-webkit-justify-content:center;justify-content:center;border:0.15em solid #fff;border-radius:0.3em;' +
            '-webkit-flex-shrink:0;flex-shrink:0;box-sizing:border-box}' +
            '.autostart-radio__icon svg{width:1.3em;height:1.3em}' +
            '.autostart-radio__name{display:none;margin-left:0.35em;white-space:nowrap;max-width:8em;overflow:hidden;' +
            'text-overflow:ellipsis}' +
            '.autostart-radio.stop .autostart-radio__icon{opacity:0.5}' +
            '.autostart-radio.loading .autostart-radio__icon{-webkit-animation:autostart-radio-blink 0.6s linear infinite alternate;' +
            'animation:autostart-radio-blink 0.6s linear infinite alternate}' +
            '.autostart-radio.play .autostart-radio__icon{-webkit-animation:autostart-radio-pulse 1.6s ease-in-out infinite;' +
            'animation:autostart-radio-pulse 1.6s ease-in-out infinite}' +
            '.autostart-radio.focus{background-color:#fff;color:#000}' +
            '.autostart-radio.focus .autostart-radio__icon{border-color:#000;opacity:1}' +
            '.autostart-radio.focus .autostart-radio__name{display:inline}' +
            '@-webkit-keyframes autostart-radio-blink{from{opacity:0.3}to{opacity:1}}' +
            '@keyframes autostart-radio-blink{from{opacity:0.3}to{opacity:1}}' +
            '@-webkit-keyframes autostart-radio-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0.5)}' +
            '50%{box-shadow:0 0 0 0.35em rgba(255,255,255,0)}}' +
            '@keyframes autostart-radio-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0.5)}' +
            '50%{box-shadow:0 0 0 0.35em rgba(255,255,255,0)}}';

        var FADE_STEP = 100;

        var audio = null;
        var button = null;
        var url = '';
        var playing = false;
        var fadeTimer = null;
        var fadePending = 0;  // ms of a fade-in that starts on "playing"
        var volume = 1;       // volume from the settings, 0..1
        var api;

        function setState(state) {
            if (button) button.removeClass('stop loading play').addClass(state);
        }

        /** Volume can be read-only on some devices: the stream then plays at full volume without a fade. */
        function setVolume(value) {
            try {
                audio.volume = Math.max(0, Math.min(1, value));
            } catch (e) { }
        }

        /** Cancel a fade-in and restore the volume from the settings, so a manual start is never silent. */
        function stopFade() {
            clearInterval(fadeTimer);

            fadeTimer = null;
            fadePending = 0;

            if (audio) setVolume(volume);
        }

        function runFade(ms) {
            var started = Date.now();

            log('custom stream: fade', ms, 'ms');

            fadeTimer = setInterval(function () {
                var progress = Math.min(1, (Date.now() - started) / ms);

                // quadratic curve: sounds smoother than a linear one; reads volume on every step,
                // so a change in the settings during the fade is picked up
                setVolume(volume * progress * progress);

                if (progress >= 1) {
                    clearInterval(fadeTimer);
                    fadeTimer = null;
                }
            }, FADE_STEP);
        }

        /** Stop the audio and close the stream connection, the icon stays. */
        function reset() {
            playing = false;

            if (audio) {
                try {
                    audio.pause();
                } catch (e) { }

                audio.removeAttribute('src');

                try {
                    audio.load();
                } catch (e) { }
            }

            stopFade();
            setState('stop');
        }

        function ensureAudio() {
            if (audio) return audio;

            audio = new Audio();
            audio.preload = 'none';

            audio.addEventListener('playing', function () {
                playing = true;
                setState('play');

                // the fade starts with the sound, buffering does not eat it
                if (fadePending) {
                    var ms = fadePending;

                    fadePending = 0;
                    runFade(ms);
                }
            });

            audio.addEventListener('waiting', function () {
                if (audio.getAttribute('src')) setState('loading');
            });

            audio.addEventListener('error', function () {
                // removing src on stop must not be reported
                if (!audio.getAttribute('src')) return;

                var failed = url;

                reset();
                notify(radioText('autostart_custom_error_play', '', failed));
            });

            return audio;
        }

        function ensureButton() {
            if (button) return button;

            if (!document.getElementById('autostart-radio-style')) {
                $('body').append('<style id="autostart-radio-style">' + STYLE + '</style>');
            }

            button = $('<div class="selector autostart-radio stop hide">' +
                '<div class="autostart-radio__icon">' + ICON_SVG + '</div>' +
                '<div class="autostart-radio__name"></div>' +
                '</div>');

            button.on('hover:enter', function () {
                if (audio && audio.getAttribute('src')) reset();
                else if (url) play(url);
            });

            // the name and the volume can be changed in the settings while the icon is shown
            try {
                Lampa.Storage.listener.follow('change', function (e) {
                    if (e.name === 'autostart_custom_name') button.find('.autostart-radio__name').text(customName());

                    if (e.name === 'autostart_custom_volume') {
                        volume = customVolume();

                        // a running fade reaches the new volume by itself
                        if (audio && !fadeTimer && !fadePending) setVolume(volume);
                    }
                });
            } catch (e) { }

            var search = $('.head__actions .open--search');

            if (search.length) search.before(button);
            else $('.head__actions').prepend(button);

            return button;
        }

        function show(value) {
            url = value;

            ensureButton().removeClass('hide');
            button.find('.autostart-radio__name').text(customName());
        }

        /**
         * @param {string} value stream url
         * @param {number} [fade] fade-in duration in ms, 0 or none: the volume from the settings at once
         */
        function play(value, fade) {
            show(value);

            // SomaFM and Radio Record stop the previous player through window.currentPlayer
            if (window.currentPlayer && window.currentPlayer !== api && typeof window.currentPlayer.destroy === 'function') {
                try {
                    window.currentPlayer.destroy();
                } catch (e) { }
            }

            window.currentPlayer = api;

            var a = ensureAudio();
            var promise;

            volume = customVolume();

            stopFade();

            if (fade > 0) {
                fadePending = fade;
                setVolume(0);
            }

            playing = false;
            setState('loading');

            a.src = value;

            try {
                promise = a.play();
            } catch (e) {
                reset();
                return;
            }

            if (promise && typeof promise['catch'] === 'function') {
                promise['catch'](function (e) {
                    // autoplay blocked or stopped while loading: keep the icon for a manual start
                    log('custom stream: play rejected', e && e.message);

                    if (!playing) reset();
                });
            }
        }

        /** Pause mode: show the icon without starting the audio. */
        function arm(value) {
            show(value);
            setState('stop');
        }

        api = {
            play: play,
            arm: arm,
            stop: reset,
            destroy: reset,
            /** Playing or loading. */
            active: function () {
                return Boolean(audio && audio.getAttribute('src'));
            },
            url: function () {
                return url;
            }
        };

        return api;
    })();

    function customName() {
        return String(Lampa.Storage.get('autostart_custom_name', '') || '').trim() || t('autostart_custom_name_default');
    }

    function customUrl() {
        return String(Lampa.Storage.field('autostart_custom_url') || CUSTOM_DEFAULT_URL).trim();
    }

    /** Player volume from the settings, 0.02..1. */
    function customVolume() {
        var percent = parseInt(Lampa.Storage.field('autostart_custom_volume'), 10) || 50;

        return Math.max(2, Math.min(100, percent)) / 100;
    }

    /** Fade-in on autostart and after a video, in ms. */
    function customFade() {
        return (parseInt(Lampa.Storage.field('autostart_custom_fade'), 10) || 0) * 1000;
    }

    /** Built in startPlugin, after the translations are added. */
    function CustomStream() {
        return {
            id: 'custom',
            name: t('autostart_custom_title'),

            check: function () {
                return /^https?:\/\/\S+$/i.test(customUrl()) ? null : t('autostart_custom_error_url');
            },

            settings: function (addParam) {
                addParam({
                    param: {
                        name: 'autostart_custom_name',
                        type: 'input',
                        values: '',
                        default: '',
                        placeholder: '#{autostart_custom_name_default}'
                    },
                    field: {
                        name: t('autostart_custom_name'),
                        description: t('autostart_custom_name_descr')
                    }
                });

                addParam({
                    param: {
                        name: 'autostart_custom_url',
                        type: 'input',
                        values: '',
                        default: CUSTOM_DEFAULT_URL,
                        placeholder: CUSTOM_DEFAULT_URL
                    },
                    field: {
                        name: t('autostart_custom_url'),
                        description: t('autostart_custom_url_descr')
                    }
                });

                addParam({
                    param: {
                        name: 'autostart_custom_mode',
                        type: 'select',
                        values: {
                            play: '#{autostart_radio_mode_play}',
                            pause: '#{autostart_radio_mode_pause}'
                        },
                        default: 'play'
                    },
                    field: {
                        name: t('autostart_radio_mode'),
                        description: radioText('autostart_radio_mode_descr', t('autostart_custom_title'))
                    }
                });

                var volumes = [2, 4, 6, 8, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
                var volumeValues = {};

                for (var v = 0; v < volumes.length; v++) volumeValues[volumes[v]] = volumes[v] + '%';

                addParam({
                    param: {
                        name: 'autostart_custom_volume',
                        type: 'select',
                        values: volumeValues,
                        default: '50'
                    },
                    field: {
                        name: t('autostart_custom_volume'),
                        description: t('autostart_custom_volume_descr')
                    }
                });

                var fades = [0, 5, 10, 20, 30, 40, 50, 60];
                var fadeValues = {};

                for (var i = 0; i < fades.length; i++) {
                    fadeValues[fades[i]] = fades[i] ? fades[i] + ' ' + t('autostart_delay_sec') : t('autostart_custom_fade_none');
                }

                addParam({
                    param: {
                        name: 'autostart_custom_fade',
                        type: 'select',
                        values: fadeValues,
                        default: '10'
                    },
                    field: {
                        name: t('autostart_custom_fade'),
                        description: t('autostart_custom_fade_descr')
                    }
                });
            },

            run: function (done, fail) {
                var url = customUrl();

                function start(stream) {
                    if (Lampa.Storage.field('autostart_custom_mode') === 'pause') CustomPlayer.arm(stream);
                    else CustomPlayer.play(stream, customFade());

                    done();
                }

                // HLS (.m3u8) and direct streams go to the audio element as is
                if (!/\.(pls|m3u)(\?|#|$)/i.test(url)) return start(url);

                var network = new Lampa.Reguest();

                network.timeout(10000);

                network['native'](url, function (text) {
                    var urls = parsePlaylist(text);

                    if (urls.length) start(urls[0]);
                    else fail(radioText('autostart_custom_error_play', '', url));
                }, function () {
                    fail(radioText('autostart_custom_error_play', '', url));
                }, false, {
                    dataType: 'text'
                });
            },

            active: function () {
                return CustomPlayer.active();
            },

            suspend: function () {
                CustomPlayer.stop();
            },

            stop: function () {
                CustomPlayer.stop();
            },

            // stream errors are reported by the player itself
            resume: function (done) {
                CustomPlayer.play(CustomPlayer.url(), customFade());
                done();
            }
        };
    }

    /* ------------------------------------------------------------------ */
    /* Resume after a video                                                */
    /* The radio stops while a video plays. If the setting allows it, the */
    /* radio that was playing starts again when the player is closed.     */
    /* ------------------------------------------------------------------ */

    var Resume = (function () {
        // a closed player sends "destroy", the next episode sends "start" right after it
        var DELAY = 1500;

        var suspended = null;  // provider stopped for a video
        var timer = null;
        var cancelIdle = function () { };  // cancels the idle wait before a resume

        function onStart() {
            clearTimeout(timer);
            cancelIdle();

            var target = activeProvider();

            // the next episode: the radio is already stopped
            if (suspended && !target) return;

            // a radio started by hand while waiting to resume replaces the suspended one
            suspended = null;

            if (!target) return;

            if (Lampa.Storage.field('autostart_resume_video') === 'resume' &&
                typeof target.suspend === 'function' && typeof target.resume === 'function') {
                suspended = target;
                target.suspend();

                log(target.id, 'stopped for a video');
            } else if (typeof target.stop === 'function') {
                // do not play the radio over a video
                target.stop();
            }
        }

        function resume() {
            // still open (next episode) or hidden (external player): the next event decides
            if (!suspended || playerOpened() || document.hidden) return;

            var target = suspended;

            cancelIdle();

            // `suspended` stays set while waiting: the next video or player close restarts the wait
            cancelIdle = waitIdle(idleSeconds('autostart_resume_idle'), function () {
                cancelIdle = function () { };

                if (suspended !== target) return;

                suspended = null;

                // the user has started a radio by hand meanwhile
                var playing = activeProvider();

                if (playing) return log('resume skipped,', playing.id, 'is playing');

                log('resume', target.id);

                try {
                    target.resume(function () { }, function (message) {
                        notify(message || target.name);
                    });
                } catch (e) {
                    notify(target.name + ': ' + e.message);
                }
            });
        }

        /** The player is closed or Lampa is back from an external player. */
        function schedule() {
            if (!suspended) return;

            clearTimeout(timer);
            cancelIdle();
            timer = setTimeout(resume, DELAY);
        }

        return {
            init: function () {
                try {
                    Lampa.Player.listener.follow('start', onStart);
                    Lampa.Player.listener.follow('external', onStart);
                    Lampa.Player.listener.follow('destroy', schedule);
                } catch (e) {
                    log('player events are not available', e);
                }

                document.addEventListener('visibilitychange', function () {
                    if (!document.hidden) schedule();
                });
            }
        };
    })();

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

            // a copy of the array, but the same entry objects that Lampa.Plugins.save() writes
            var list = Lampa.Plugins.get();
            var title = t('autostart_title');
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

            if (changed) {
                Lampa.Plugins.save();
                log('extension entry named', title);
            }
        } catch (e) {
            log('cannot name the extension entry', e);
        }
    }

    function startPlugin() {
        window.plugin_autostart_radio_ready = true;

        log('version', VERSION);

        addTranslations();
        nameSelf();

        Lampa.Manifest.plugins = {
            type: 'other',
            version: VERSION,
            name: t('autostart_title'),
            description: 'Launch a radio channel (SomaFM, Radio Record or a custom stream) on app start',
            component: COMPONENT
        };

        Lampa.AutostartRadio = {
            version: VERSION,
            register: register,
            providers: function () {
                return providers.slice();
            }
        };

        register(SomaFM);
        register(RadioRecord);
        register(CustomStream());

        try {
            document.dispatchEvent(new CustomEvent('lampa_autostart_radio_ready'));
        } catch (e) { }

        if (window.appready) onReady();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') onReady();
            });
        }
    }

    if (!window.plugin_autostart_radio_ready) startPlugin();
})();
