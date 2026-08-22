# Invariantes de Segurança e Operação Fiscal (NFS-e DEXMED)

- **Filosofia Operacional:** Supervised Automation — dados suficientes + padrão conhecido + validações técnicas OK → emitir.
- **Tratamento de Resposta do Provedor:** Resposta determinística do provedor (erros cadastrais/tributários como EL78, EL244) → classificar como `REJECTED_CORRECTABLE`, corrigir e prosseguir; resultado ambíguo (timeout/queda de conexão) → impedir duplicidade e reconciliar via `ConsultarNfsePorRps`.
- **Produção Supervisionada:** Emissão em produção tecnicamente habilitada sob supervisão do usuário, com kill switch operacional de emergência (`NFE_ISSUE_KILL_SWITCH=true`).
- **Cancelamento e Substituição:** Cancelamento automático desabilitado nesta etapa — cancelamento manual sob supervisão do usuário no portal fiscal se necessário.
- **Certificado Digital A1:** Operações autenticadas exigem certificado A1 válido e compatível com a DEXMED.
- **Fail-Closed Técnico:** Validação estrita W3C XSD Schema 2.04 e assinatura XMLDSig C14N com verificação nativa `xmlsec1`.
- **Idempotência e Ledger:** Alocação atômica de RPS antes do envio; consulta prévia por RPS para garantir entrega exactly-once.
- **Google Sheets:** Preservar a integridade das abas estruturadas (Notas, Demandas, Tomadores, Padrões, RPS).
- **Sem Dados Hardcoded Silenciosos:** Município de prestação e município de incidência do ISS são campos distintos; alíquotas e retenções são dinâmicas ou omitidas quando zero.
- **Separação de Padrões:** HIC Plantões PS SUS e HIC Produção PS SUS mantêm-se notas separadas. CISURG utiliza descrição do espelho mensal da competência.
- **Segurança de Segredos:** Nunca expor tokens, senhas, chaves privadas ou certificados nos logs ou relatórios.
