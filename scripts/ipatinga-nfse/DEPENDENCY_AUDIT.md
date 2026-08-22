# Auditoria de dependências

Data: 2026-08-21

`npm audit` reporta cinco achados moderados e nenhum achado alto ou crítico.

| Pacote | Origem | Impacto neste projeto | Decisão |
| --- | --- | --- | --- |
| `fast-xml-parser <5.7.0` | Direto | A vulnerabilidade é do `XMLBuilder` ao receber delimitadores não escapados. A automação não constrói XML fiscal a partir de entrada externa com esse builder; payloads ABRASF são construídos por funções determinísticas. | Mantido em 4.x. A correção disponível exige major 5 e será avaliada separadamente. |
| `uuid <11.1.1` | Transitivo de `gaxios/googleapis-common` | Afeta UUID v3/v5/v6 quando o chamador fornece buffer. A automação não chama essas APIs nem fornece buffers. | Mantido; correção exige atualização major de `googleapis`. |
| `gaxios 6.4.0–6.7.1` | Transitivo | Herdado exclusivamente do alerta de `uuid`; não há uso direto. | Mantido com o SDK atual. |
| `googleapis-common <=7.2.0` | Transitivo | Herdado exclusivamente do alerta de `uuid`. | Mantido com o SDK atual. |
| `googleapis 33–149` | Direto | O fix sugerido é `googleapis@176`, uma atualização major ampla. As APIs usadas hoje são Sheets v4 e Drive v3. | Não atualizado indiscriminadamente antes do primeiro sync; migrar em tarefa isolada com testes reais Google. |

O risco residual é aceito temporariamente porque os caminhos vulneráveis não são acionados pela automação e os fixes sugeridos são upgrades major. O lockfile fixa exatamente a árvore auditada.
