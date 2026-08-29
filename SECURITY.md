# Security

Repozytorium jest przygotowane jako wersja portfolio i nie zawiera danych runtime ani sekretów.

## Celowo wykluczone

- `.env`,
- token Apify,
- credentiale dostawcy LLM,
- baza `.data/market-radar.sqlite`,
- profil przeglądarki / cookies / sesje,
- logi i artefakty testowe,
- lokalne dane z wykonanych researchy.

Eksporty workflowów n8n zostały oczyszczone z identyfikatorów credentiali i metadanych konkretnej instancji. Po imporcie należy ręcznie przypiąć własny credential modelu LLM.

## Sieć

Domyślna konfiguracja jest local-first:

- aplikacja: `127.0.0.1:7654`,
- n8n: `127.0.0.1:5678`.

Workflowy n8n nie mają dodatkowego uwierzytelnienia webhooków, ponieważ w tej wersji są przeznaczone do działania wyłącznie na loopbacku. Przed wystawieniem systemu do Internetu należy dodać warstwę autoryzacji i reverse proxy.

## Meta Ads / Apify

Token Apify przechowywany jest wyłącznie lokalnie w `.env`.

System analizuje publicznie dostępne sygnały reklamowe. Nie należy interpretować jego klasyfikacji jako potwierdzonej sprzedaży, ROAS ani rentowności produktu.
