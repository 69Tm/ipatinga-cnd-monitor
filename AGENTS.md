# Invariantes de Segurança e Operação Fiscal (NFS-e DEXMED)

- **Filosofia Operacional:** Supervised Automation — dados suficientes + padrão conhecido + validações técnicas OK → emitir sob supervisão humana.
- **Validação Estrita de TLS:** Chamadas SOAP HTTPS utilizam estritamente `rejectUnauthorized: true`. Falhas de certificado TLS do servidor interrompem o workflow (fail-closed).
- **Tratamento de Resposta do Provedor:** 
  - Erros determinísticos (como EL78, EL244) → classificar como `REJECTED_CORRECTABLE`, corrigir e prosseguir somente após reconciliação via RPS confirmar `RPS_NOT_FOUND_CONFIRMED`.
  - Aceitação assíncrona ADN (`"Solicitação recebida! Aguarde a confirmação..."`) → classificar como `SUBMITTED_ASYNC_PROCESSING` e aguardar reconciliação via `reconcile_rps`.
  - Falha ambígua / timeout → classificar como `UNKNOWN_AFTER_TIMEOUT` e reconciliar via `reconcile_rps` sem nova emissão automática.
- **Ciclo de Tentativas (Attempt Count):** Máximo de 5 tentativas de correção por item/demanda. Ao atingir o limite, o registro é bloqueado como `FAILED_SAFE` para revisão manual.
- **Reconciliação Explícita (`reconcile_rps`):** Operação dedicada para consultar e sincronizar o status definitivo de notas pendentes no ADN ou após timeout sem invocar `GerarNfse`.
- **Produção Supervisionada:** Emissão em produção tecnicamente habilitada sob supervisão do usuário, com kill switch operacional de emergência (`NFE_ISSUE_KILL_SWITCH=true`).
- **Isolamento de Homologação:** A sincronização em homologação não afeta nem altera a aba operacional `Notas` de produção.
- **Cancelamento e Substituição:** Cancelamento automático desabilitado nesta etapa — cancelamento manual sob supervisão do usuário no portal fiscal se necessário.
- **Certificado Digital A1:** Operações autenticadas exigem certificado A1 válido e compatível com a DEXMED.
- **Fail-Closed Técnico:** Validação estrita W3C XSD Schema 2.04 e assinatura XMLDSig C14N com verificação nativa `xmlsec1`.
- **Idempotência e Ledger:** Alocação atômica de RPS antes do envio; consulta prévia por RPS para garantir entrega exactly-once (`ALREADY_ISSUED`).
- **Google Sheets:** Preservar a integridade das abas estruturadas (`Notas`, `Demandas`, `Tomadores`, `Padrões de Emissão`, `RPS`).
- **Sem Dados Hardcoded Silenciosos:** Município de prestação e município de incidência do ISS são campos distintos e registrados explicitamente na aba Padrões de Emissão (`3131307` para Ipatinga).
- **TODO Futuro (Dados Bancários):** `BANKING-PAYMENT-BLOCK` parametrizável centralmente via `NFE_PAYMENT_INSTRUCTIONS` para substituição da tag `{BLOCO_BANCARIO}`.
- **Segurança de Segredos & Logs Sanitizados:** Nunca expor tokens, senhas, chaves privadas, certificados ou payloads XML brutos nos logs ou relatórios.
