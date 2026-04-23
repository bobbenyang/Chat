# GLM Chat Companion

Small local web app for chatting through a local Node server.

## Features

- Server-side API key via `OPENROUTER_API_KEY`, `GLM_API_KEY`, or `GLM_API`
- Configurable default model via `GLM_MODEL`
- Optional model switcher list via comma-separated `GLM_MODELS`
- Local browser persistence for settings and chat history
- Character picker using the bundled avatar art in `Characters/`
- Persona or "character card" prompt box for roleplay/chat setup
- Dependency-light Node server with no external packages

## Run

Create a local secret file:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local`:

```bash
OPENROUTER_API_KEY="your_key_here"
GLM_CHAT_ENDPOINT="https://openrouter.ai/api/v1/chat/completions"
GLM_MODEL="nousresearch/hermes-2-pro-llama-3-8b"
GLM_MODELS="nousresearch/hermes-2-pro-llama-3-8b,deepseek/deepseek-v3.2,cognitivecomputations/dolphin-mistral-24b-venice-edition:free"
```

Start the app:

```bash
npm start
```

Then open `http://localhost:3000`.

## Notes

- The API key is read from `.env.local` or the local server environment.
- The browser never receives or stores the API key.
- The app sends chat requests to an OpenAI-compatible chat endpoint.

## Character files

Each character folder can include a `character.json` file:

```json
{
  "english": {
    "name": "Character Name",
    "prompt": "Write the English character prompt here.",
    "first_line": "Write the character's first English line here."
  },
  "chinese": {
    "name": "角色名字",
    "prompt": "在这里写中文角色提示词。",
    "first_line": "在这里写角色的中文开场白。"
  }
}
```

The app uses the matching language name and prompt when chatting. If the language is set to Auto or English, it uses the English fields. If the language is Chinese, it uses the Chinese fields.

Shared presets for every character can be placed in `Characters/relationship_presets.json`. Character-specific presets can be placed in each character folder as `relationship_presets.json`; those appear before the shared presets.

```json
{
  "presets": [
    {
      "id": "friend",
      "english": {
        "label": "Friend",
        "relationship": "Describe the English relationship preset here.",
        "first_line": "Write the first line for this relationship."
      },
      "chinese": {
        "label": "朋友",
        "relationship": "在这里写中文关系预设。",
        "first_line": "在这里写这个关系下的开场白。"
      }
    }
  ]
}
```

These presets appear as horizontal buttons below Relationship in character settings. Clicking one fills Relationship and First Line.
