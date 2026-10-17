# Moat Evaluator

**Moat or head start?** An interactive tool for evaluating the competitive moat of any product or platform, based on the framework in [Finding a Real Moat in the AI Era](https://deepakmukunthu.substack.com/p/finding-a-real-moat-in-the-ai-era).

A moat gets stronger with use and harder to copy the longer you hold it. A head start just decays. This tool scores a product against the article's five moat types and three stress tests, then tells you which one you have.

## Features

- **Two modes**
  - **Manual:** answer 25 questions yourself, with a live score as you go.
  - **Automated:** enter one or more company or product names. Claude answers every question with a rationale and a confidence level, and you can review and override each answer.
- **Side-by-side comparison** of up to 5 companies: overall score, verdict, each moat type, copy timeline and red flags.
- **Results:** a 0–100 score and verdict, strength by moat type, a breakdown of how the score was built, red flags, an execution check and build/buy/partner recommendations.
- **Save and share:** a local library, Markdown and JSON export, JSON import and print to PDF.
- Light and dark themes. No build step, and no data leaves your machine except the calls to Claude in automated mode.

## The framework

| Moat type | What it asks |
|---|---|
| Proprietary data | Does usage create unique data that makes the product better? |
| Distribution and network effects | Does each new user make it more valuable? Do you own your channel? |
| Workflow and switching costs | How embedded is it? What would leaving cost a customer? |
| Scarce inputs | Do you have privileged access to compute, talent or an ecosystem? |
| Trust and permission to operate | Licences, certifications, safety record, legal exposure |

Three stress tests then check whether the moat is real:
- **Copy timeline and half-price test:** how fast could a funded competitor match you, and would your margins survive a rival at half your price?
- **Usage effect:** does usage make you stronger, or just more expensive?
- **Vulnerability:** single model-vendor dependency, and the risks that could erode your position.

### Scoring

- **Core strength** = 65% of the strongest moat + 35% of the second strongest. One deep moat beats several shallow ones.
- **Adjustments** come from the usage test, half-price test, vendor dependency, erosion risks and copy timeline.
- **Copy-timeline cap:** if a competitor could match you in under 12 months, it's a head start by definition. The score is capped at 30 for under 6 months and at 45 for 6–12 months.
- **Bands:** 70+ real moat · 50–69 emerging · 30–49 head start · under 30 no moat yet.

## Quick start

Requires Node.js 20 or later.

```bash
git clone https://github.com/deepak-mukunthu/moat-evaluator.git
cd moat-evaluator
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # only needed for automated mode
npm start
```

Open http://127.0.0.1:8765/.

Manual mode works without an API key. You can get a key from the [Claude Console](https://console.anthropic.com/).

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key for automated mode |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | — | Use an Anthropic-compatible gateway instead of the API directly |
| `MOAT_MODEL` | `claude-opus-5-5` | Model used for analysis |
| `PORT` | `8765` | Port to listen on |

## How automated analysis works

1. **Reads your sources (optional).** The server fetches any URLs you supply, such as an About page or an investor-relations page. Private and local network addresses are blocked.
2. **Researches the company.** Claude searches the web for current facts about it. If your provider doesn't support the web search tool, the app falls back to the model's training knowledge plus your URLs, and says so in the results.
3. **Scores it.** Claude answers every question in the framework, giving a choice, a confidence level and a rationale for each, plus key evidence and caveats.

Each analysis takes about one to three minutes. When you compare several companies, up to three run at once.

Treat the results as a starting point, not a verdict. The model can be wrong or out of date. Every answer shows its reasoning so you can check it and change it.

## Project structure

```
server.js            Node server: static files, /api/status, /api/analyze (NDJSON progress stream)
public/index.html    The app (UI, scoring, results, comparison)
public/framework.js  Questions, options and examples from the framework
```

The server binds to `127.0.0.1` only. It is intended to run locally, not as a public service.

## License

[MIT](LICENSE)
