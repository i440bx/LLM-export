# LLM Export

LLM Export is a Firefox extension for exporting ChatGPT conversations to PDF, HTML, or Markdown.

It is an independent, open-source browser extension and is not affiliated with, endorsed by, or sponsored by OpenAI.

## Current support

The current release supports ChatGPT at `https://chatgpt.com/`.

The name **LLM Export** is intentionally broader so support for additional LLM web interfaces can be added in the future. At present, references to ChatGPT in the user interface describe the service the extension actually works with.

## Privacy

Export processing takes place in the browser. The extension does not contain analytics or telemetry and does not send conversation content to the extension maintainer or another analytics service.

For Markdown export, the extension uses the authenticated ChatGPT web session to retrieve the conversation from ChatGPT's conversation backend. Images may be retrieved using download URLs supplied by ChatGPT so they can be included in the exported file.

## Origin of this fork

LLM Export is derived from **ChatGPT Export**, originally created by **Enes Saltik** and distributed under the Mozilla Public License 2.0.

This fork was created from ChatGPT Export 9.3.0. Its initial purpose was to preserve the existing export functionality while removing the unrelated search-provider override introduced in that release. The extension was subsequently renamed to **LLM Export**. The core export implementation remains derived from the original project.

For detailed attribution, see [`ATTRIBUTION.md`](ATTRIBUTION.md).

## License

The extension's covered source code is distributed under the **Mozilla Public License 2.0 (MPL-2.0)**. See [`LICENSE`](LICENSE).

The source code for this release is included in the extension distribution and can be inspected by unpacking the XPI/ZIP archive. Third-party libraries retain their respective upstream licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Export formats

- PDF
- HTML
- Markdown

## Building / packaging

The extension does not require a compilation step for its own source files. To create an XPI, package the extension files with `manifest.json` at the root of the archive.

Example on Linux/macOS:

```sh
zip -r llm-export.xpi . \
  -x '*.git*' \
  -x '*.DS_Store'
```

Firefox extensions distributed publicly through Mozilla Add-ons must be signed by Mozilla.
