# Плагины для Lampa

Плагины для [Lampa](https://github.com/yumata/lampa-source). Каждый плагин — один файл ES5 без сборки,
подключается по URL: **Настройки → Расширения → Добавить плагин**, затем перезапустите Lampa.

| Плагин | Что делает | Адрес для установки | Документация |
|---|---|---|---|
| Автозапуск радио | При старте Lampa (сразу, с задержкой, при неактивности или на паузе) запускает радио: SomaFM, Radio Record или свой поток; может включать его снова после видео | `https://etix-git.github.io/lampa-plugins/autostart-radio.js` | [docs/autostart-radio.md](docs/autostart-radio.md) |
| Субтитры: Plus | Кнопка «С+»: свой слой субтитров с настройками размера, цвета, положения и задержки; вшитые субтитры торрентов на webOS через прокси на ТВ | `https://etix-git.github.io/lampa-plugins/subtitles-plus.js` | [docs/subtitles-plus.md](docs/subtitles-plus.md) |
| Сброс настроек субтитров | Пункт «Сбросить настройки» в меню субтитров плеера | `https://etix-git.github.io/lampa-plugins/subtitles-reset.js` | [docs/subtitles-reset.md](docs/subtitles-reset.md) |
| Запуск в Vplayer | На webOS добавляет «Vplayer» (`com.sostk.vplayer`) в тип плеера в настройках (видео, IPTV, торренты) и пункт «Запустить плеер - Vplayer» в меню долгого нажатия на файл торрента | `https://etix-git.github.io/lampa-plugins/vplayer-launch.js` | [docs/vplayer-launch.md](docs/vplayer-launch.md) |
