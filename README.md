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
