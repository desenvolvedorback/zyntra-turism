# Zyntra Turismo

Sistema de geracao automatica de roteiros turisticos: busca hoteis, restaurantes
e pontos turisticos de uma cidade, monta uma rota otimizada dividida
automaticamente pelo numero de dias informado, e avisa no mapa quando a rota
passa perto de uma area marcada como de alto risco.

## Stack

- Backend: **Node.js + Express** (unica dependencia de terceiros)
- Frontend: **HTML + CSS + JavaScript puro** (sem framework), com **Leaflet.js**
  apenas para desenhar o mapa
- Dados de cidade/POIs: **OpenStreetMap** (Nominatim para geocodificar, Overpass
  API para hoteis/restaurantes/atracoes) — gratuito, sem chave de API
- Sem banco de dados. Stateless.

## Como rodar

```bash
npm install
npm start
```

Acesse `http://localhost:3000`.

> Requer Node.js 18+ (usa `fetch` nativo).
> Requer acesso a internet em tempo de execucao (para consultar Nominatim e
> Overpass). Se o ambiente onde for hospedado bloquear rede de saida, ajuste
> as configuracoes de rede do servidor.

## Como funciona

1. O usuario informa a cidade e a quantidade de dias.
2. O backend geocodifica a cidade (Nominatim) e busca, dentro do bounding box
   da cidade, atracoes turisticas, hoteis e restaurantes (Overpass API).
3. As atracoes sao agrupadas em N clusters geograficos (N = dias) usando um
   k-means simplificado, e cada dia e ordenado por vizinho mais proximo para
   minimizar deslocamento.
4. Para cada dia, o sistema sugere o restaurante mais proximo do centro do
   roteiro daquele dia, e no geral lista os hoteis mais proximos do centro de
   todas as atracoes.
5. Cada trecho da rota e comparado contra as zonas de risco cadastradas em
   `data/crime-zones.json`. Se um trecho passar dentro do raio de uma zona,
   um aviso e exibido no painel lateral e a area e desenhada em vermelho/laranja
   no mapa.

## Configurando areas de risco

O arquivo `data/crime-zones.json` **nao vem com dados reais pre-carregados** —
o sistema nao presume saber quais bairros sao perigosos em qual cidade. Cabe a
voce preencher com uma fonte confiavel (secretaria de seguranca publica local,
portal de dados abertos da prefeitura, policia civil/militar, etc).

Formato:

```json
{
  "sao paulo": [
    {
      "name": "Nome da area",
      "lat": -23.55052,
      "lon": -46.633308,
      "radius_m": 400,
      "level": "alta"
    }
  ]
}
```

- A chave e o nome da cidade em minusculas e sem acentos (ex: `"rio de janeiro"`).
- `level` pode ser `"alta"` ou `"media"` (muda a cor no mapa: vermelho / laranja).
- `radius_m` e o raio da area em metros.

Existe uma entrada `"exemplo"` no arquivo apenas para mostrar o formato — ela
usa uma chave que nunca vai casar com uma cidade real, entao nao afeta buscas.

## Estrutura de arquivos

```
zyntra-turismo/
  server.js              -> backend Express (geocoding, POIs, clusterizacao, checagem de risco)
  package.json
  data/
    crime-zones.json     -> zonas de risco configuraveis por cidade
  public/
    index.html
    style.css             -> identidade visual Zyntra
    app.js                -> mapa Leaflet + consumo da API + renderizacao
```

## Identidade visual (Zyntra)

- Paleta: Azul `#007BFF`, Ciano `#00E5FF`, Preto `#0D0D0D`
- Tipografia: Inter (400-800)
- Estilo: futurista minimalista
- Contraste AA+ e navegacao por teclado (`:focus-visible` em todos os
  elementos interativos)

## Limitacoes conhecidas

- A cobertura de hoteis/restaurantes/atracoes depende do quanto a cidade esta
  mapeada no OpenStreetMap — cidades pequenas podem retornar poucos pontos.
- A Overpass API publica (`overpass-api.de`) tem limites de uso; para producao
  com muito trafego, considere hospedar sua propria instancia Overpass ou usar
  um provedor pago (Google Places, etc.), trocando apenas a funcao
  `fetchPois` em `server.js`.
- O calculo de "passar perto de uma area de risco" e uma aproximacao
  geometrica (distancia ponto-segmento), nao leva em conta ruas reais.
