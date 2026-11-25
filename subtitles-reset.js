/**
 * "Reset subtitle settings" plugin for Lampa
 *
 * Adds the "Reset settings" item to the built-in "Subtitles" menu of the player (gear in the player
 * panel -> Subtitles), right after "Shift time". The item returns every built-in subtitle setting of
 * Lampa to its default value:
 *   - player menu: size, outline, backdrop, time shift;
 *   - Settings -> Player -> Subtitles: auto start, language, source, ASS mode, ASS fonts, ASS readability
 *     (only the keys this Lampa build knows);
 *   - webOS native subtitle parameters (webos_subs_params), as nb557's reset_subs.js did.
 * Settings of other plugins (for example subtitles-plus.js) are not touched.
 *
 * Plain ES5, no build step: the file is the plugin entry point.
 */
(function () {
    'use strict';

    var VERSION = '1.0.0';
    var ITEM_NAME = 'reset_subs';
    var SHIFT_NAME = 'player_subs_shift_time';

    // keys reset to the default from Lampa.Params.defaults (skipped if the build does not know them)
    var PARAM_KEYS = [
        'subtitles_size',
        'subtitles_stroke',
        'subtitles_backdrop',
        'subtitles_start',
        'subtitles_lang',
        'subtitles_source',
        'subtitles_ass_mode',
        'subtitles_ass_fonts',
        'subtitles_ass_readable'
    ];

    // keys without an entry in Lampa.Params.defaults
    var RAW_DEFAULTS = {
        player_subs_shift_time: '0',
        webos_subs_params: '{}'
    };

    function t(name) {
        return Lampa.Lang.translate(name);
    }

    function log() {
        var args = Array.prototype.slice.call(arguments);

        args.unshift('ResetSubs');
        console.log.apply(console, args);
    }

    function addTranslations() {
        Lampa.Lang.add({
            reset_subs_title: {
                ru: 'Сбросить настройки',
                en: 'Reset settings',
                uk: 'Скинути налаштування',
                be: 'Скінуць налады'
            },
            reset_subs_descr: {
                ru: 'Вернуть все настройки субтитров по умолчанию',
                en: 'Restore all subtitle settings to defaults',
                uk: 'Повернути всі налаштування субтитрів за замовчуванням',
                be: 'Вярнуць усе налады субтытраў па змаўчанні'
            },
            reset_subs_done: {
                ru: 'Настройки субтитров сброшены',
                en: 'Subtitle settings have been reset',
                uk: 'Налаштування субтитрів скинуто',
                be: 'Налады субтытраў скінуты'
            },
            reset_subs_plugin: {
                ru: 'Сброс настроек субтитров',
                en: 'Reset subtitle settings',
                uk: 'Скидання налаштувань субтитрів',
                be: 'Скід налад субтытраў'
            }
        });
    }

    /**
     * Repeat applySettings() of Lampa: its listener is not exported, so update the classes directly
     */
    function applyLook() {
        var layer;

        try {
            layer = Lampa.PlayerVideo.render().find('.player-video__subtitles');
        } catch (e) {
            layer = $('.player-video__subtitles');
        }

        if (!layer || !layer.length) return;

        layer.removeClass('has--stroke has--backdrop size--normal size--large size--small');
        layer.addClass('size--' + Lampa.Storage.field('subtitles_size'));

        if (Lampa.Storage.field('subtitles_stroke')) layer.addClass('has--stroke');
        if (Lampa.Storage.field('subtitles_backdrop')) layer.addClass('has--backdrop');
    }

    function reset() {
        var defaults = (Lampa.Params && Lampa.Params.defaults) || {};
        var done = [];

        for (var i = 0; i < PARAM_KEYS.length; i++) {
            var key = PARAM_KEYS[i];

            if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;

            Lampa.Storage.set(key, defaults[key]);
            done.push(key);
        }

        for (var name in RAW_DEFAULTS) {
            if (!Object.prototype.hasOwnProperty.call(RAW_DEFAULTS, name)) continue;

            Lampa.Storage.set(name, RAW_DEFAULTS[name]);
            done.push(name);
        }

        applyLook();

        log('reset', done.join(', '));

        Lampa.Noty.show(t('reset_subs_done'));
    }

    /**
     * Add our item to the built-in "Subtitles" menu of the player before Lampa draws it
     */
    function onSelectPreshow(e) {
        var params = e && e.active;

        if (!params || params._reset_subs || !params.items || typeof params.onSelect !== 'function') return;
        if (params.title !== t('settings_player_subs')) return;

        // the track choice menu is called "Subtitles" too: look for the time shift item
        var shiftIndex = -1;

        for (var i = 0; i < params.items.length; i++) {
            if (params.items[i] && params.items[i].name === SHIFT_NAME) shiftIndex = i;
        }

        if (shiftIndex < 0) return;

        var original = params.onSelect;

        params.items.splice(shiftIndex + 1, 0, {
            title: t('reset_subs_title'),
            subtitle: t('reset_subs_descr'),
            name: ITEM_NAME
        });

        params.onSelect = function (a) {
            if (a && a.name === ITEM_NAME) reset();
            else return original.apply(this, arguments);
        };

        params._reset_subs = true;
    }

    function onReady() {
        Lampa.Select.listener.follow('preshow', onSelectPreshow);
    }

    function startPlugin() {
        window.plugin_reset_subs_ready = true;

        log('version', VERSION);

        addTranslations();

        Lampa.Manifest.plugins = {
            type: 'other',
            version: VERSION,
            name: t('reset_subs_plugin'),
            description: 'Adds "Reset settings" to the player subtitles menu: restores all built-in subtitle settings',
            component: 'reset_subs'
        };

        if (window.appready) onReady();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') onReady();
            });
        }
    }

    if (!window.plugin_reset_subs_ready) startPlugin();
})();
