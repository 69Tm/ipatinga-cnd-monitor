# Proveniência dos Schemas ABRASF 2.04 (Ipatinga/MG)

- **Órgão Normativo:** ABRASF (Associação Brasileira das Secretarias de Finanças das Capitais)
- **Município:** Ipatinga / MG (Provedor SigCorp - Meu Município Online)
- **Versão:** ABRASF v2.04
- **Pacote Referência:** `Schemas_abrasf.rar` / Especificação Técnica ABRASF 2.04
- **Data de Registro:** 2026-08-22
- **Namespace Raiz:** `http://www.abrasf.org.br/nfse.xsd`
- **WSDLs Reais Vinculados:**
  - Produção: `https://abrasfipatinga.meumunicipio.online/ws/nfs?wsdl`
  - Homologação: `https://testeipatinga.meumunicipio.online/abrasf/ws/nfs?wsdl`

## Arquivos e Hashes SHA-256

| Arquivo | Tamanho (bytes) | SHA-256 |
|---|---|---|
| `nfse.xsd` | 1869 | `f8368b7c0b38fecfc8e53f25d8685d615f0f7fa588af969c8413fb770b74f5d4` |
| `tipos_complexos_v03.xsd` | 4603 | `764751b67446dfe3384b2869ad614c928b61f20beb666d4c2cbd33ffe3310599` |
| `tipos_simples_v03.xsd` | 4083 | `8408801da75f2c8dcb443a24151d8435c3eccce8ac57eb0f11d4447f59d6fd7f` |
| `xmldsig-core-schema.xsd` | 7971 | `ca9fe660c98d188a705760057ef5816230972ffc04355a8dd94ce50352a5e4f2` |

## Operações Suportadas
1. `GerarNfseEnvio` (Geração síncrona / emissão de NFS-e unitária com RPS)
2. `ConsultarNfseFaixaEnvio` (Consulta de NFS-e por faixa de numeração)
3. `ConsultarNfsePorRpsEnvio` (Consulta pós-emissão / idempotência por RPS)
