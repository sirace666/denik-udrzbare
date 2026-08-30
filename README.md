# Deník údržbáře – appka pro sledování oprav

Appka, která zjednoduší život lidem na opravě. Jednoduchá webová appka (PWA) pro záznam oprav a údržby strojů — časomíra, historie, správa strojů, materiál, fotky. Appka je zdarma, funguje offline a neukládá žádná data mimo tvoje zařízení.

**Appka funguje na počítači i na mobilu** – stejná appka, stejná adresa, appka sama pozná, na čem ji otevíráš, a přizpůsobí tomu rozvržení (na PC širší mřížky a postranní menu, na mobilu jednosloupcový layout s lištou dole). Klidně ji používej na obojím zároveň – jen si pamatuj, že data (viz níže) zůstávají oddělená pro každé zařízení/prohlížeč zvlášť.

## Co appka umí

- **START/STOP časomíra** – spustíš při příchodu na opravu, appku klidně zavřeš, čas běží dál na pozadí (uloženo v telefonu). Po návratu dáš STOP a přiřadíš stroj.
- **Databáze strojů** – stroje jsou organizované do kategorií s vlastní ikonou a barvou (39 ikon, 20 barev pro stroje, 20 odstínů fialové pro kategorie). Rychlé vyhledávání i zakládání nového stroje přímo z pickeru.
- **Čtyři typy záznamu** – CM práce / CM Oprava (zelená/žlutá) a EM oprava s prostojem / bez prostoje (červená/oranžová). Doba prostoje jde upravit odděleně od doby na místě.
- **Zápis opravy** – číslo WO, závada, řešení, fotky z fotoaparátu nebo galerie, materiál (počet kusů, skladové číslo, název).
- **Materiál za běhu opravy** – fotky i materiál jde přidávat, upravovat i mazat přímo během běžící časomíry, ne až po STOP.
- **Historie** – přehled podle roku i měsíce, statistiky (počty CM/CM Oprava/EM, celkový čas prostojů), detail dne se seznamem záznamů.
- **Hledání** – v rámci roku nebo konkrétního měsíce, podle textu (závada, řešení, WO, materiál), stroje nebo typu opravy, kombinovatelné.
- **Galerie** – všechny fotky napříč opravami na jednom místě, řazené podle data, s možností hromadně sdílet/kopírovat/stáhnout/smazat.
- **Přiblížení fotek** – gesto přiblížení/oddálení (pinch), tažení při přiblížení, dvojklik pro rychlý zoom – funguje všude, kde appka zobrazuje fotku na celou obrazovku.
- **Vlastní time picker** – appka nepoužívá systémový výběr času (ten na mobilu přetékal mimo obrazovku), ale vlastní ovládání s minutami po 5, ať je zadávání rychlé a konzistentní.
- **Automatické zaokrouhlení** – čas se zaokrouhluje na 5 minut, nová oprava na dnešní den se předvyplní aktuálním časem.
- **Záloha a obnova dat** – export do souboru a import zpátky, přímo v appce (Nastavení).
- **Světlý/tmavý/systémový vzhled** – appka se přizpůsobí nastavení telefonu, nebo jde vybrat ručně.
- **Přizpůsobení širokým obrazovkám** – na monitoru appka automaticky přepne na desktopové rozvržení: postranní menu vlevo místo spodní lišty, širší mřížky u Strojů a Galerie (víc sloupců), postranní panel s dnešními opravami na Timeru, a přiměřeně omezená šířka formulářů a detailů, ať se nenatahují přes celou obrazovku. Na telefonu zůstává appka beze změny.
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

1. Vytvoř nový repozitář na GitHubu (např. `denik-udrzbare`), může být i public bez obav – appka neposílá žádná data nikam ven.
2. Nahraj do něj všech 6 souborů výše (do kořene repozitáře, ne do podsložky) a taky `.nojekyll` (prázdný soubor, aby GitHub Pages neignoroval soubory se začátečním podtržítkem/tečkou).
3. V nastavení repozitáře: **Settings → Pages → Source: Deploy from branch → Branch: main → / (root)**.
4. Za chvíli appka poběží na `https://tvoje-jmeno.github.io/denik-udrzbare/`.

## Používání na počítači (Windows/Mac/Linux)

Appka běží v běžném prohlížeči (Chrome, Edge, Firefox) – stačí otevřít adresu appky a rovnou appku používat, žádná instalace potřeba. Appka na širší obrazovce sama přepne na desktopové rozvržení (postranní menu, širší přehledy) – viz seznam funkcí výše.

Appku jde volitelně i „nainstalovat" jako samostatné okno bez adresního řádku prohlížeče (funguje v Chrome a Edge):

1. Otevři appku v prohlížeči **Chrome** nebo **Edge**.
2. V adresním řádku vpravo klikni na ikonu instalace (malý monitor s šipkou), nebo přes nabídku prohlížeče (tři tečky) vyber **„Nainstalovat appku"**.
3. Appka se otevře ve vlastním okně a přidá se do nabídky Start / Launchpadu jako běžný program.

## Instalace na plochu telefonu – Android

1. Otevři appku v prohlížeči **Chrome** na adrese, kde appka běží.
2. Klepni na nabídku (tři tečky vpravo nahoře).
3. Vyber **„Přidat na plochu"** nebo **„Nainstalovat aplikaci"**.
4. Potvrď název a klepni na **„Přidat"** / **„Instalovat"**.
5. Appka se objeví na ploše jako běžná aplikace a půjde spouštět i offline.

## Instalace na plochu telefonu – iOS (iPhone/iPad)

1. Otevři appku v prohlížeči **Safari** (musí to být Safari, ne Chrome – jinak nabídka pro přidání na plochu chybí).
2. Klepni na tlačítko **Sdílet** (ikona čtverečku se šipkou dole uprostřed lišty).
3. Sjeď v nabídce dolů a vyber **„Přidat na plochu"**.
4. Potvrď název a klepni na **„Přidat"** vpravo nahoře.
5. Appka se objeví na ploše jako běžná aplikace a půjde spouštět i offline.

Appka nainstalovaná na ploše (PC i mobil) se pak chová jako běžná aplikace – vlastní ikona, běží bez adresního řádku prohlížeče, funguje i bez připojení k internetu.

## Důležité – kam mizí data

Data (stroje, záznamy oprav, fotky) se ukládají **jen v tomto konkrétním zařízení a jen v tomto konkrétním prohlížeči**. To znamená:

- Když appku odinstaluješ nebo vymažeš data prohlížeče, data zmizí. Appka má v Nastavení **export/import zálohy** – vyplatí se ji občas udělat.
- Data z telefonu se **automaticky nezobrazí** na počítači ani naopak – i když appku otevřeš na obou, každé zařízení má svoje vlastní, oddělené záznamy, dokud je ručně nepřeneseš přes export/import.
- Pokud budeš chtít v budoucnu vidět historii i odjinud (PC, jiný telefon) automaticky a najednou, řešením by bylo napojit appku na cloudové úložiště (např. Firebase) – ale to už je větší krok, ne první.

## Aktualizace appky

Appka má vlastní mechanismus, který při každém spuštění zkontroluje, jestli je na GitHub Pages novější verze, a pokud ano, sama se obnoví. Po nahrání nové verze na GitHub se tedy telefon aktualizuje automaticky při příštím otevření appky – není potřeba nic odinstalovávat.

## Podpora vývoje

V appce (Nastavení → „Podpoř vývoj appky") je odkaz na dobrovolný příspěvek – appka je a zůstane zdarma, příspěvek je čistě dobrovolný.

## Co by šlo příště doplnit

- Export měsíce/směny do CSV nebo PDF pro reporting
- Historie oprav per stroj (kolikrát byl v EM, celkový čas)
- Cloudová synchronizace mezi zařízeními
- Zamykání obrazovky proti náhodnému stisku při práci v kapse
