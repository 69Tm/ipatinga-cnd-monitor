# Monitor e Renovação Automática de CND Municipal (Ipatinga)

Automação para consulta, validação e emissão de Certidão Negativa de Débitos (CND) Municipais de Ipatinga com Playwright, Gemini Flash OCR, Google Drive, Google Sheets, Bark e E-mail via GitHub Actions.

## Estrutura do Projeto

```
.
├── .github/
│   └── workflows/
│       └── cnd.yml
└── scripts/
    └── ipatinga-cnd/
        ├── package.json
        ├── main.js
        └── helpers.js
```

## NFS-e DEXMED

The fiscal engine preserves ABRASF 2.04 for historical reads and the pre-cutover write window. For Simples Nacional issuance dated 2026-10-21 or later, it routes to the National Issuer provider and fails closed until production access and the authoritative current route are validated. It never falls back to legacy ABRASF for current DEXMED production writes. See [provider routing and migration evidence](docs/nfse-provider-routing.md).

Already-sent requests marked `COMPLETED_SENT` return `ALREADY_COMPLETED` before legacy RPS ledger creation. Reconciled national DPS documents live in `Ledger NFS-e Nacional`; no RPS values are fabricated. The external reconciliation helper requires a sent reply and exact official document matches, and blocks ambiguous or incomplete evidence.

The current national adapter's request builders and read paths are unit-tested. Production writing remains intentionally disabled until DEXMED's current Emissor Nacional credentials, production API route, and read-only validation are confirmed against the official Swagger and municipal enrollment.

## Secrets Necessários no Repositório

Para a execução no GitHub Actions, configure as seguintes secrets em **Settings > Secrets and variables > Actions**:

- `DEXMED_CNPJ`: CNPJ da empresa (somente números ou formatado).
- `DRIVE_FOLDER_ID`: ID da pasta do Google Drive onde os PDFs emitidos serão salvos.
- `GOOGLE_SERVICE_ACCOUNT_JSON`: Credenciais JSON da Service Account Google (com permissão no Drive e Planilha de controle).
- `GEMINI_KEY`: Chave da API do Google Gemini (usada para quebra do Captcha).
- `BARK_KEY`: Chave para envio de notificações push via Bark.
- `SMTP_USER`: Usuário/e-mail para envio de alertas.
- `SMTP_PASSWORD`: Senha de app do e-mail.
- `ALERT_EMAIL`: E-mail de destino dos alertas.
