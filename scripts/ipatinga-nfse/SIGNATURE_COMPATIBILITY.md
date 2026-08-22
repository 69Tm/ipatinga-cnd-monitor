# Compatibilidade e Análise da Assinatura Digital XMLDSig (Ipatinga / ABRASF 2.04)

## 1. Contexto Normativo e Especificações ABRASF 2.04
No padrão ABRASF versão 2.04 e no provedor SigCorp / Meu Município Online (Prefeitura de Ipatinga / MG), a assinatura digital ICP-Brasil segue as seguintes regras estritas:

- **Algoritmo de Canonicalização:** Canonical XML 1.0 sem comentários (`http://www.w3.org/TR/2001/REC-xml-c14n-20010315`).
- **Algoritmo de Digest:** SHA-1 (`http://www.w3.org/2000/09/xmldsig#sha1`).
- **Algoritmo de Assinatura:** RSA com SHA-1 (`http://www.w3.org/2000/09/xmldsig#rsa-sha1`).
- **Transforms Obrigatórios:**
  1. `http://www.w3.org/2000/09/xmldsig#enveloped-signature`
  2. `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`
- **KeyInfo:** Deve conter o elemento `X509Data` com o certificado digital público do prestador (`X509Certificate`) em formato Base64 DER.

---

## 2. Análise Estrutural: URI de Referência e Posicionamento da Assinatura

### A. O que o Schema Oficial (`schema_2.04.xsd`) Define
No schema oficial de Ipatinga (`schema_2.04.xsd`), o tipo `tcDeclaracaoPrestacaoServico` e o elemento `GerarNfseEnvio` são definidos como:
```xml
<xsd:complexType name="tcDeclaracaoPrestacaoServico">
    <xsd:sequence>
        <xsd:element name="InfDeclaracaoPrestacaoServico" type="tcInfDeclaracaoPrestacaoServico" minOccurs="1" maxOccurs="1" />
        <xsd:element ref="dsig:Signature" minOccurs="0" maxOccurs="1" />
    </xsd:sequence>
</xsd:complexType>
```
E `tcInfDeclaracaoPrestacaoServico` possui o atributo:
```xml
<xsd:attribute name="Id" type="tsIdTag" />
```

### B. O que o Exemplo Oficial de Ipatinga (`GerarNfse.xml`) Apresenta
No arquivo oficial fornecido no pacote `Schemas_abrasf.rar` (`GerarNfse.xml`):
- A assinatura `<Signature>` fica posicionada imediatamente dentro do `<Rps>` (irmã do `<InfDeclaracaoPrestacaoServico>`).
- O elemento `<Reference>` utiliza `URI=""` com os transforms `C14N` e `enveloped-signature`.

### C. O que o Manual Geral ABRASF 2.04 e Padrões Estaduais Utilizam
Em implementações de RPS isolado com identificador único (ex: `Id="RPS1001A"`), a referência utiliza `URI="#RPS1001A"`. Ambas as abordagens são suportadas e válidas pelo schema `schema_2.04.xsd`.

---

## 3. Decisão de Implementação para o Gate de Homologação
1. **URI de Referência:** Adotamos `URI="#${targetId}"` apontando diretamente para o atributo `Id` do `InfDeclaracaoPrestacaoServico`, garantindo correspondência unívoca do fragmento RPS assinado.
2. **Contexto de Namespace:** Durante a canonicalização C14N, o nó assinado herda o namespace raiz `http://www.abrasf.org.br/nfse.xsd`.
3. **Validação Criptográfica Dupla:**
   - **Interna:** Via biblioteca W3C `xml-crypto` e `@xmldom/xmldom`.
   - **Independente no Runner de CI:** Verificação via ferramenta nativa `xmlsec1` (`xmlsec1 --verify`).
