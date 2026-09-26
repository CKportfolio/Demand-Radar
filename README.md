Demand Radar



Local-first workbench do badania sygnałów popytu na produkty cyfrowe na podstawie publicznie dostępnych reklam Meta Ads. Łączy planowanie researchu przez model, pobieranie danych przez Apify, lokalną bazę SQLite oraz kontrolowaną klasyfikację reklam przez workflowy n8n.

Demand Radar nie szacuje sprzedaży, ROAS ani rentowności konkurencji. Wskazuje sygnały warte dalszego badania: ciągłość kampanii, długość emisji, powtarzalność kreacji i rodzin ofert.

Dlaczego powstał

Ręczny research rynku oznacza dziesiątki zapytań, setki reklam i dużo powtarzalnej selekcji: które wyniki są przypadkowym dopasowaniem słowa, które prowadzą do tej samej oferty, a które pokazują realną kontynuację kampanii.

Pierwsza wersja systemu spinała ten pipeline. Obecna wersja zamienia go w narzędzie robocze: użytkownik widzi etap pracy, może kontrolować rozmiar paczki i koszt klasyfikacji, zatrzymać proces, wrócić do niego po błędzie oraz analizować wyniki bez czekania na pełne wczytanie wszystkich szczegółów.

Co robi

brief / obszar kompetencji
        ↓
MR01 — plan odkrywania rynku
        ↓
MR02 — rozmowa i rewizja planu
        ↓
MR03 — plan zapytań
        ↓
Apify + Meta Ads Library
        ↓
SQLite: deduplikacja, lifecycle, rodziny ofert
        ↓
MR04 — filtrowanie danych: KEEP / REJECT / POTENCJALNE
        ↓
MR05 — drugi przebieg tylko dla POTENCJALNYCH
        ↓
Workbench: filtry, Timeline, CSV i ręczna decyzja

Najważniejsze możliwości

Modularny Workbench z osobnymi zakładkami: panel roboczy, zapisane projekty, plan zapytań i przegląd wyników.

Planowanie badania: MR01 generuje plan, MR02 pozwala go zrewidować, MR03 buduje plan zapytań i seedów.

Pobieranie oraz deduplikacja reklam Meta Ads przez Apify; dane pozostają w lokalnej bazie SQLite.

Klasy lifecycle pojedynczych reklam: BALON_PROBNY, TEST_W_TOKU, ROKUJACA, MOCNA, EVERGREEN.

Grupowanie reklam w rodziny ofert oraz niezależny modal Timeline: bloki reklam są ułożone na osi czasu, mają kolory lifecycle, tooltip z metadanymi i link do reklamy.

Filtrowanie relewancji MR04 z decyzjami KEEP, REJECT, POTENCJALNE, ręcznym nadpisaniem decyzji oraz pełnym cofnięciem segregacji.

MR05 jako drugi, bardziej stanowczy przebieg wyłącznie dla reklam nierozstrzygniętych po MR04.

Kontrola kosztu i obciążenia modelu: wybór paczki od 1 do 200 reklam (domyślnie 20), sekwencyjne wysyłanie, limit 14 wywołań/min oraz retry po błędach przejściowych.

Trwały postęp MR04/MR05 zapisany po każdej paczce w SQLite; przyciski STOP/WZNÓW pozwalają wrócić wyłącznie do pozostałych reklam.

Odświeżanie postępu i statystyk w tle — bez przeładowania strony ani zmiany aktywnej zakładki.

Stopniowe pobieranie szczegółów reklam podczas przeglądania wyników, eksport pełnego i skróconego CSV.

Architektura

Warstwa

Odpowiedzialność

Node.js / server.js

Lokalne API, orkiestracja pobierania i kolejki klasyfikacji

SQLite / better-sqlite3

Projekty, plany, reklamy, decyzje, postęp zadań i rodziny ofert

n8n

Wymienne workflowy LLM dla MR01–MR05

Apify

Pobieranie reklam z Meta Ads Library

Vanilla HTML/CSS/JS

Workbench, filtry, modal Timeline i aktualizacje UI

Frontend jest celowo rozdzielony na moduły w public/js/tabs/; index.html pozostaje lekkim szkieletem aplikacji, a nie jednym wielotysięcznym plikiem.

Struktura repozytorium

.
├── index.html                 # szkielet Workbencha
├── public/
│   ├── css/workbench.css      # style UI
│   └── js/
│       ├── tabs/              # moduły czterech zakładek
│       └── timeline-modal.js  # niezależny widok rodzin ofert
├── server.js                  # API i orkiestracja zadań
├── src/
│   ├── db/                    # SQLite, migracje, repozytoria
│   └── meta/                  # harvesting, relevance, lifecycle, offer families
├── n8n/
│   ├── workflows/             # eksporty MR01–MR05
│   ├── prompts/
│   └── schemas/
├── tests/
├── docs/architecture/
└── scripts/

Uruchomienie lokalne

Wymagania: Node.js 22, Docker Desktop oraz konto/credential wybranego dostawcy modelu w n8n.

Copy-Item .env.example .env
npm ci
.\scripts\n8n-up.ps1
npm start

Następnie:

Otwórz n8n pod http://127.0.0.1:5678.

Zaimportuj workflowy z n8n/workflows/.

Podepnij własne credential modelu do węzłów modelu i aktywuj workflowy.

Otwórz Workbench pod http://127.0.0.1:7654.

Szczegóły konfiguracji MR04/MR05, trybu testowego i limitu wywołań opisuje n8n/README.md. Do repozytorium nie trafiają .env ani .data/market-radar.sqlite.

Kontrola procesu MR04/MR05

Każde wywołanie webhooka n8n zawiera jedną paczkę. Aplikacja, nie workflow n8n, jest właścicielem kolejki: dzieli rekordy, mierzy postęp, ogranicza tempo, zapisuje wynik pojedynczej paczki i obsługuje zatrzymanie/wznowienie.

TEST wysyła dokładnie jedną paczkę do webhook-test; przed wywołaniem n8n musi nasłuchiwać zdarzenia testowego.

PRODUCTION przetwarza pozostałą kolejkę sekwencyjnie.

Model może zostać wymieniony w n8n bez zmiany aplikacji. Konfiguracja domyślna ma trzy próby ponowienia błędów przejściowych co 10 sekund.

Kontrola jakości

npm run ci

CI w GitHub Actions używa Node.js 22 i uruchamia kontrolę składni, testy modułów, smoke testy oraz walidację kontraktu Discovery Plan.

Status

Working prototype / portfolio project.

Projekt pokazuje przejście od jednorazowo spiętego automatu do obsługiwalnego narzędzia researchowego: z widocznym stanem pracy, odzyskiwaniem po błędzie, kontrolą kosztu modelu i interfejsem do interpretacji danych.