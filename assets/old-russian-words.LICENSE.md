# Old Russian topic words

`old-russian-words.txt` contains 2,630 headwords from the Russian Wiktionary category [Древнерусские существительные](https://ru.wiktionary.org/wiki/Категория:Древнерусские_существительные), retrieved on 2026-09-30 through the public MediaWiki API. Credit: Russian Wiktionary contributors. Each line is the unchanged title of a source entry; its article and contributor history are available at `https://ru.wiktionary.org/wiki/<word>` and the article's History tab.

This word list is distributed under [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/). This license applies to the word-list asset, separately from the application's MIT license. No dictionary definitions or examples are included.

Selection: retrieve all main-namespace members of the category with `action=query&list=categorymembers&cmtitle=Категория:Древнерусские существительные&cmnamespace=0&cmlimit=500`, following `cmcontinue`. Keep unique page titles matching `^[а-яё]{3,16}$`, sort them, and write one title per line. This keeps compact, single-word nouns in familiar Cyrillic without altering their historical spelling. Some words remain in use today. It is a practical naming list, not a complete linguistic dictionary.

The application capitalizes the initial letter for display and picks uniformly from the bundled list using Node's `crypto.randomInt`. Repetition is possible; no network requests, model inference or usage-history storage are involved.
