# Údržba – appka pro sledování oprav

## Co appka umí

- **START/STOP časovač** – spustíš při příchodu na opravu, appku klidně zavřeš, čas běží dál na pozadí (uloženo v telefonu). Po návratu dáš STOP.
- **Databáze strojů** – po STOP vyhledáš stroj podle názvu, nebo rovnou založíš nový.
- **Zápis opravy** – typ CM (zelená, bez prostoje) / EM (oranžová, s prostojem), číslo WO, závada, řešení, fotky z fotoaparátu nebo galerie.
- **Historie** – kalendářní přehled podle dní, filtr CM/EM, statistiky (počty, celkový čas prostojů EM).
- **Funguje offline** – vše se ukládá lokálně v telefonu (IndexedDB), žádný účet, žádný server, žádný internet potřeba pro běžný provoz.

## Soubory

```
index.html       – vstupní stránka
app.jsx          – veškerá logika appky (jeden soubor, snadno upravitelný)
manifest.json    – definice PWA (název, ikona, barvy)
sw.js            – service worker (offline cache)
icon-192.png     – ikona appky (malá)
icon-512.png     – ikona appky (velká)
```

## Nasazení na GitHub Pages

1. Vytvoř nový repozitář na GitHubu (např. `udrzba-app`), může být i public bez obav – appka neposílá žádná data nikam ven.
2. Nahraj do něj všech 6 souborů výše (do kořene repozitáře, ne do podsložky).
3. V nastavení repozitáře: **Settings → Pages → Source: Deploy from branch → Branch: main → / (root)**.
4. Za chvíli appka poběží na `https://tvoje-jmeno.github.io/udrzba-app/`.

## Instalace na Android telefon

1. Otevři tu adresu v Chrome na telefonu.
2. Chrome nabídne **„Přidat na plochu"** (nebo menu ⋮ → „Přidat na plochu" / „Nainstalovat aplikaci").
3. Appka se objeví jako ikona na ploše a chová se jako nativní appka (bez adresního řádku prohlížeče).

## Důležité – kam mizí data

Data (stroje, záznamy oprav, fotky) se ukládají **jen v tomto konkrétním telefonu a jen v tomto konkrétním prohlížeči**. To znamená:

- Když appku odinstaluješ nebo vymažeš data prohlížeče Chrome, data zmizí. Zálohu zatím appka nedělá – to je první věc, kterou má smysl doplnit, až budeš appku chvíli používat a uvidíš, jestli ti to takhle stačí.
- Data se nezobrazí na jiném telefonu ani na PC – jsou jen tady.
- Pokud budeš chtít v budoucnu vidět historii i odjinud (PC, jiný telefon), řešením by bylo napojit appku na Firebase (podobně jako u SPT) – ale to už je druhý krok, ne první.

## Co by šlo příště doplnit

- Export měsíce/směny do CSV nebo PDF pro reporting
- Historie oprav per stroj (kolikrát byl v EM, celkový čas)
- Záloha/obnova dat (export/import JSON)
- Zamykání obrazovky proti náhodnému stisku při práci v kapse
