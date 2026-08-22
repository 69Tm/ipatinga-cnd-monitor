# Proveniência dos Schemas ABRASF 2.04 (Prefeitura de Ipatinga / MG)

- **URL Oficial de Download:** `https://ipatinga.meumunicipio.online/ISS/download/Schemas_abrasf.rar`
- **Data do Download:** 2026-08-22
- **Tamanho do Arquivo .RAR Original:** 23886 bytes (23.886 bytes)
- **SHA-256 do Pacote .RAR Original:** `dd0809665b646f92abb01b2da609aad468c62cb1db2a4a66aacce90a8fded882`
- **Provedor:** SigCorp / Meu Município Online
- **Versão:** ABRASF v2.04
- **WSDL Produção:** `https://abrasfipatinga.meumunicipio.online/ws/nfs?wsdl`
- **WSDL Homologação:** `https://testeipatinga.meumunicipio.online/abrasf/ws/nfs?wsdl`

## Lista Integral dos Arquivos Extraídos do Pacote Oficial

| Arquivo Extraído | Caminho Original no .RAR | Tamanho (bytes) | SHA-256 |
|---|---|---|---|
| `CancelarNfse.xml` | `Schemas_abrasf/CancelarNfse.xml` | 4389 | `66b9d1556f9af1a820029e1606e82cf3f08cf97a4d3364aa442d037c6219b11a` |
| `ConsultarLoteRpsEnvio.xml` | `Schemas_abrasf/ConsultarLoteRpsEnvio.xml` | 379 | `beb97f1501ff1ef5ac0b4ffe5e60efb25c8a46c1c7a6cf1a604cbaf724235c87` |
| `ConsultarNfseFaixaEnvio.xml` | `Schemas_abrasf/ConsultarNfseFaixaEnvio.xml` | 454 | `e1f6bce532cbacf7effcb84d742fc4f708e5435eb36b350219a6c9c40d770911` |
| `ConsultarNfsePorRps.xml` | `Schemas_abrasf/ConsultarNfsePorRps.xml` | 429 | `1acf506ea383ee3ffd4bb72b402fd7ed52b7c0a0a77a43640be6788b05806919` |
| `ConsultarNfseServicoPrestadoEnvio.xml` | `Schemas_abrasf/ConsultarNfseServicoPrestadoEnvio.xml` | 493 | `f915a9aad171df69c0a0af6b210c378e226c07e26c4e46f0db5f2a7d60d6e2df` |
| `ConsultarNfseServicoTomadoEnvio.xml` | `Schemas_abrasf/ConsultarNfseServicoTomadoEnvio.xml` | 553 | `c1a977b3bb8b75ec9b54e0143ec0cb2ac2a98dd0aaf9949b872ea6212bfde5f5` |
| `EnviarLote.xml` | `Schemas_abrasf/EnviarLote.xml` | 9930 | `bdd6385e7b8942a23f7978fbf98698327e68b2e4a5f85443204a1a8b4b721363` |
| `GerarNfse.xml` | `Schemas_abrasf/GerarNfse.xml` | 8697 | `5a32bcf0080bd3a47383bc696e6cc7912cfd5cea74606a405a6677b05596ce93` |
| `SubstituirNfseEnvio.xml` | `Schemas_abrasf/SubstituirNfseEnvio.xml` | 10180 | `be9ac65337679cd38ee0630a2406ac89d3289d33bceeb33f64877b729dc0f7fb` |
| `schema_2.04.xsd` | `Schemas_abrasf/xsd/schema_2.04.xsd` | 74516 | `0a44201d3e1732ad4a1a5951b7ef14870a6ff03e5f23147932c41e14661d7e7b` |

## Schema Responsável por GerarNfse
- **Arquivo Raiz:** `nfse.xsd` (Define o elemento raiz `GerarNfseEnvio`, `ConsultarNfseFaixaEnvio`, etc.)
- **Imports:** `tipos_complexos_v03.xsd`, `tipos_simples_v03.xsd`, `xmldsig-core-schema20020212.xsd`
