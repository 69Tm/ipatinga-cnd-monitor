# NFS-e provider routing for DEXMED

Last verified against official sources: 2026-10-21.

## Write policy

- Historical Simples Nacional issuance before 2026-10-21 may use the legacy Ipatinga ABRASF 2.04 writer.
- From 2026-10-21, the router selects `NATIONAL_ISSUER` for DEXMED. It never falls back to the ABRASF writer. Until production access and the exact emitter route are independently validated, writes fail closed with `NATIONAL_ISSUER_WRITE_NOT_VALIDATED`.
- The legacy provider remains available for historical reads and reconciliation. Its `submit()` checks the effective issue date and refuses current DEXMED writes.
- The separate Sigcorp national-DPS adapter is retained as a request builder only. It is not the current route for DEXMED because the official municipality notice and the provider manual give different Simples Nacional transition dates.
- Use emission date for provider selection. Commercial service reference and NFS-e competence are separate data.

## Official source evidence

1. Ipatinga's taxpayer login notice currently says that Simples Nacional issuers must use Emissor Nacional from 2026-10-21: <https://ipatinga.meumunicipio.online/ISS/index.php>.
2. The municipal portal separately publishes a national-layout web-service integration path: <https://ipatinga.meumunicipio.online/ISS/download/WS_Nacional.php>.
3. Sigcorp's complementary manual, version 1.01 dated 2026-09-01, documents a municipal DPS endpoint at `https://webservice.meumunicipio.online/v1/nfse`, with Basic authentication, a prestador CNPJ header, a caller-supplied NFS-e number, asynchronous protocol consultation, and a note that Simples Nacional issuers move directly to the national portal on 2026-11-01: <https://sigcorp.com.br/manual-complementar-de-integracao-nfse/>.
4. The official National NFS-e production API page lists the production contributor Swagger and restricted-test Swagger separately: <https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao>.
5. The official contributor API manual documents synchronous `POST /nfse`, `GET /nfse/{chaveAcesso}`, and `GET`/`HEAD /dps/{id}` operations. Its production Swagger endpoint was returning HTTP 502 during this audit, so production authentication and payload details could not be live-validated: <https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf>.

The municipality's effective date (October 21) and Sigcorp's platform-specific Simples date (November 1) do not establish that the local Sigcorp web service remains an authorized route after October 20. The router therefore follows the municipal Emissor Nacional notice and blocks all production writes until the DEXMED contributor credentials, current production API route, DPS schema rules, and a read-only validation path have been confirmed. No classification for IBS/CBS is inferred from the older ABRASF templates. The Sigcorp manual says the IBS/CBS group must not be sent for an optante do Simples Nacional.

## Data and recovery model

National DPS records live in `Ledger NFS-e Nacional`, with no RPS number. Existing `RPS` rows and historical ABRASF documents are preserved. `COMPLETED_SENT` is terminal for replay; a completed demand returns `ALREADY_COMPLETED` before any ledger creation, certificate check, or provider write.

External-recovery matching requires the sent message to belong to the original thread, every official DANFSe attachment to originate from that sent message, and exact CNPJ, recipient, reference period, service description and amount matches for every requested item. Value-only matches, incomplete six-certificate packages, and ambiguous document matches fail closed.
