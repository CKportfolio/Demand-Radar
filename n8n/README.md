# n8n workflows

Warstwa LLM systemu Demand Radar składa się z czterech workflowów:

- **MR-01 Generate Discovery Plan** — zamienia możliwości/tło twórcy w szeroki plan obszarów do zbadania.
- **MR-02 Revise Discovery Plan** — pozwala iteracyjnie poprawić plan.
- **MR03 Meta Ads Query Planner** — rozwija plan do konkretnych zapytań wyszukiwawczych.
- **MR04 Ad Relevance Filter** — ocenia znalezione reklamy i odrzuca wyniki niepasujące do celu badania.

## Import

1. Uruchom lokalne n8n:
   ```powershell
   .\scripts\n8n-up.ps1
   ```
2. Otwórz `http://127.0.0.1:5678`.
3. Zaimportuj JSON-y z `n8n/workflows/`.
4. W każdym node `OpenAI Chat Model` (lub zamienionym modelu) przypnij własny credential.
5. Aktywuj workflowy.

Eksporty w repo są celowo pozbawione credential IDs i metadanych prywatnej instancji n8n.
