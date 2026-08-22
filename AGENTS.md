# Invariantes de segurança

- Nunca emitir NFS-e em produção sem autorização explícita futura e específica.
- Nunca chamar `GerarNfse`, cancelar ou substituir NFS-e automaticamente.
- Manter bloqueios redundantes de emissão em produção no workflow e no CLI.
- Consultas NFS-e em produção são permitidas somente por serem operações de leitura.
- Não executar sync fiscal autenticado sem certificado A1 carregado, válido e compatível com a DEXMED.
- Uma falha técnica, SOAP, ABRASF, de certificado, parsing ou Google deve falhar o workflow.
- Um sync só escreve no Google Sheets depois de concluir e validar todas as consultas.
- `dry_run=true` significa zero escrita externa: Google Sheets, Drive, GitHub e sistema fiscal.
- Google Sheets é o contrato de estado da automação fiscal; preservar as 24 colunas e os campos humanos.
- GitHub Actions é o executor fiscal. Gmail e seu fluxo continuam no Google Apps Script.
- Não modificar nem quebrar os workflows existentes de CND sem solicitação explícita.
- Não hardcodar alíquota ISS, valores ou campos fiscais variáveis.
- Manter separados os padrões HIC Plantões PS SUS e HIC Produção PS SUS.
- Para CISURG, o espelho da competência é a fonte do descritivo; histórico serve apenas para validação.
- Nunca registrar tokens, senhas, service account JSON, PFX, chaves privadas ou Authorization.
- Fixtures e logs devem conter somente dados sintéticos ou já públicos, sem secrets.
