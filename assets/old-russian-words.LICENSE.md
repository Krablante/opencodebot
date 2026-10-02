# Old Russian topic words

`old-russian-words.txt` contains 2,630 headwords from the Russian Wiktionary category [Древнерусские существительные](https://ru.wiktionary.org/wiki/Категория:Древнерусские_существительные), retrieved on 2026-09-30 through the public MediaWiki API. Credit: Russian Wiktionary contributors. Each line is the unchanged title of a source entry; its article and contributor history are available at `https://ru.wiktionary.org/wiki/<word>` and the article's History tab.

This word list is distributed under [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/). This license applies to the word-list asset, separately from the application's MIT license. No dictionary definitions or examples are included.

Selection: retrieve all main-namespace members of the category with `action=query&list=categorymembers&cmtitle=Категория:Древнерусские существительные&cmnamespace=0&cmlimit=500`, following `cmcontinue`. Keep unique page titles matching `^[а-яё]{3,16}$`, sort them, and write one title per line. This keeps compact, single-word nouns in familiar Cyrillic without altering their historical spelling. Some words remain in use today. It is a practical naming list, not a complete linguistic dictionary.

The application combines this unchanged list with `russian-image-words.txt`, an independently curated list of 853 additional Russian nouns covered by the application's MIT license. The additional words describe animals, plants, objects, landscapes, traditional life and fairy-tale imagery in modern spelling. They are selected for recognizable meanings and distinct images, rather than historical language classification; no third-party word collection was copied.

The combined pool contains 3,483 unique words. Node's `crypto.randomInt` picks a word uniformly, then independently picks lowercase, uppercase or an initial capital with equal probability. Repetition is possible; both files load once, with no network requests, model inference or usage-history storage.
