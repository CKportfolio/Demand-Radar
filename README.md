# Demand Radar

Lokalne narzędzie do badania **sygnałów popytu na produkty cyfrowe** poprzez analizę reklam z Meta Ads Library.

Projekt powstał po poznaniu ręcznej metody researchu stosowanej przez twórców szkoleń i produktów internetowych: zamiast zaczynać od własnego pomysłu na produkt, najpierw sprawdzać, **co konkurenci konsekwentnie reklamują i do jakich ofert prowadzą ich kampanie**.

Zautomatyzowałem ten proces.

## Problem

Ręczny research wymagał:

- wymyślania wielu zapytań do Meta Ads Library,
- przeglądania dużej liczby reklam,
- odrzucania wyników przypadkowych i nieistotnych,
- sprawdzania jak długo reklamy są emitowane,
- rozpoznawania, kiedy wiele reklam prowadzi do tej samej oferty,
- porównywania kolejnych testów i wariantów kreacji,
- składania wszystkiego w arkusz do dalszej analizy.

Demand Radar automatyzuje większość tej pracy i zostawia człowiekowi etap interpretacji.

## Co analizuje

System **nie zna rzeczywistej sprzedaży, budżetu reklamowego, ROAS ani rentowności konkurencji**.

Zamiast tego szuka publicznie widocznych **traction signals**, m.in.:

- długości emisji reklamy,
- tego, czy reklama nadal jest aktywna,
- powtarzających się reklam tej samej oferty,
- kolejnych kreacji kierujących do tego samego produktu,
- kontynuacji kampanii po krótkim teście,
- powrotów tej samej oferty po przerwie.

Założenie badawcze jest proste: jeżeli reklamodawca przez dłuższy czas utrzymuje ofertę lub uruchamia wiele kolejnych reklam prowadzących do tego samego produktu, jest to **silniejszy sygnał zainteresowania rynku** niż pojedynczy, krótki test.

To nadal sygnał — nie dowód sprzedaży.

## Jak działa

```text
możliwości / obszar twórcy
        ↓
MR-01: Discovery Plan (LLM)
        ↓
MR-02: rewizja planu
        ↓
MR03: Query Planner (LLM)
        ↓
zapytania Meta Ads Library
        ↓
Apify / Facebook Ads Library Scraper
        ↓
deduplikacja + zapis do SQLite
        ↓
MR04: filtr relewancji (LLM)
        ↓
lifecycle pojedynczych reklam
        ↓
grupowanie reklam w rodziny ofert
        ↓
Workbench / filtry / CSV
```

## Klasyfikacja reklam

Pojedyncza reklama otrzymuje klasę zależną od długości emisji:

- **BALON_PROBNY** — do 7 dni,
- **TEST_W_TOKU** — 8–30 dni,
- **ROKUJACA** — 31–90 dni,
- **MOCNA** — 91–180 dni,
- **EVERGREEN** — powyżej 180 dni.

Progi są heurystyką researchową, nie oceną wyniku finansowego reklamy.

## Rodziny ofert

Sam czas życia pojedynczej reklamy może być mylący. Dlatego Demand Radar próbuje również rozpoznać **wiele reklam należących do tej samej oferty**.

Przy grupowaniu bierze pod uwagę m.in.:

- reklamodawcę / `page_id`,
- docelowy URL po usunięciu parametrów trackingowych,
- `collation_id`, jeśli występuje,
- podobieństwo tytułu i treści,
- relację czasową między kolejnymi reklamami.

Rodzina może zostać sklasyfikowana jako:

- `TEST_ONLY`,
- `REPEATED_TEST`,
- `PROMISING`,
- `ESTABLISHED`,
- `EVERGREEN`.

Pozwala to odróżnić pojedynczą próbę od oferty, która jest konsekwentnie rozwijana, odświeżana i ponownie reklamowana.

## Workbench

Interfejs pozwala m.in.:

- tworzyć i zapisywać projekty researchowe,
- generować i poprawiać Discovery Plan,
- edytować seedy oraz query plan,
- zatwierdzić plan przed uruchomieniem badania,
- uruchomić research Meta Ads,
- obserwować postęp badania,
- filtrować reklamy,
- uruchomić AI-owy filtr relewancji,
- ręcznie nadpisać decyzję filtra,
- analizować klasy lifecycle,
- przeglądać rodziny ofert,
- pobrać pełny lub skrócony CSV.

## Dane i baza

Aplikacja korzysta z lokalnego SQLite.

Baza **nie jest częścią repozytorium**. Przy pierwszym uruchomieniu:

```text
.data/market-radar.sqlite
```

jest tworzona automatycznie, a migracje zakładają wymagane tabele i indeksy.

W repo nie ma historycznych researchy ani danych z poprzednich uruchomień.

## Technologie

- Node.js
- JavaScript
- SQLite / `better-sqlite3`
- n8n
- LLM workflows
- Ajv / JSON Schema
- Apify
- Meta Ads Library
- HTML / CSS / JavaScript
- Docker Compose

## Uruchomienie

### 1. Zależności aplikacji

```bash
npm install
```

### 2. Konfiguracja

Skopiuj:

```text
.env.example → .env
```

Uzupełnij przede wszystkim:

```env
APIFY_API_TOKEN=...
```

### 3. Uruchom n8n

Na Windows:

```powershell
.\scripts\n8n-up.ps1
```

Następnie otwórz:

```text
http://127.0.0.1:5678
```

i zaimportuj workflowy z:

```text
n8n/workflows/
```

Po imporcie przypnij własny credential modelu LLM i aktywuj workflowy.

### 4. Uruchom aplikację

```bash
npm start
```

Workbench:

```text
http://127.0.0.1:7654
```

## Struktura

```text
.
├── index.html                 # Workbench
├── server.js                 # lokalne API / orkiestracja
├── src/
│   ├── db/                   # SQLite, migracje, repozytoria
│   └── meta/                 # harvesting, relevance, lifecycle, offer families
├── n8n/
│   ├── workflows/            # MR-01 ... MR04
│   ├── prompts/
│   └── schemas/
├── docs/
│   └── architecture/
│       └── DiscoveryPlanV1.schema.json  # kontrakt walidowany przez aplikację
├── scripts/
├── screenshots/
├── docker-compose.n8n.yml
└── .env.example
```

## O projekcie

Najważniejszym elementem projektu nie jest samo pobranie reklam, ale zamiana nieustrukturyzowanego procesu researchowego w powtarzalny workflow:

**problem biznesowy → plan badania → zapytania → dane → filtr jakości → heurystyki → grupowanie ofert → materiał do decyzji**

System ma pomagać odpowiedzieć na pytanie:

> **„Które obszary i oferty wyglądają na warte dalszego zbadania?”**

a nie:

> „Który produkt na pewno się sprzedaje?”.

## Status

**Working prototype / portfolio project**

Aktualna wersja działa lokalnie i wykorzystuje Apify jako provider danych z Meta Ads Library oraz n8n jako warstwę LLM.

Projekt jest narzędziem researchowym. Wyniki wymagają interpretacji człowieka i nie powinny być traktowane jako potwierdzenie sprzedaży, rentowności ani skuteczności reklam.
