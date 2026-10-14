# growatt-monitor

Dashboard local para acompanhar em tempo real quanto sua usina Growatt está
gerando, com suporte a múltiplas contas guardadas num vault criptografado no
próprio navegador.

## Funcionalidades

- Potência atual, energia de hoje e energia total acumulada, por usina.
- Múltiplas contas Growatt, cada uma com seu próprio card no painel.
- Login/senha de cada conta ficam num vault local criptografado (AES-GCM +
  PBKDF2) no navegador, protegido por usuário + senha mestre.
- Sessão persiste entre recarregamentos de página; botão de logout bloqueia
  o vault sem apagar as contas salvas.
- Troca de usuário/senha do vault pela própria interface.
- Intervalo de atualização do painel configurável (5s/10s/30s/60s).

## Como funciona

- **Backend** (Python/Flask): fala com a nuvem da Growatt através da lib
  [`growattServer`](https://github.com/indykoning/PyPi_GrowattServer) (API
  não-oficial/reversa) e expõe `/api/status` e `/api/accounts`. Cada conta
  cadastrada tem sua própria sessão HTTP e thread de consulta periódica,
  isoladas das demais.
- **Frontend** (HTML/CSS/JS puro, sem build): guarda as credenciais
  criptografadas no navegador e as envia ao backend local apenas para abrir
  a sessão de cada conta.

As credenciais **não ficam salvas no servidor** — só em memória, enquanto a
conta está ativa.

## Requisitos

- Python 3.10+
- Uma conta Growatt (as mesmas credenciais do app ShinePhone/Growatt)
- Navegador moderno (Chrome, Edge, Firefox). O vault usa a Web Crypto API,
  que só fica disponível em `http://localhost`, `http://127.0.0.1` ou
  `https://` — não funciona acessando por IP de rede em HTTP puro.

## Instalação

```bash
git clone <url-do-repositorio>
cd growatt-monitor

python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

pip install -r requirements.txt
cp .env.example .env           # ajuste porta/intervalo de polling se quiser
python app.py
```

Acesse **http://localhost:5000** (ou a porta definida no `.env`).

### Com Docker

```bash
docker compose up --build
```

ou, sem `docker-compose`:

```bash
docker build -t growatt-monitor .
docker run -p 5000:5000 -e GROWATT_POLL_INTERVAL=30 growatt-monitor
```

Acesse **http://localhost:5000** no navegador que está na mesma máquina
onde o Docker roda.

## Acessar de outro aparelho na rede (celular, outro PC)

Pelo IP da máquina em HTTP puro (ex. `http://192.168.0.138:5000`) o vault
não funciona — o navegador só libera a Web Crypto API em `localhost` ou em
conexões HTTPS (veja [Requisitos](#requisitos)). A forma mais simples de
contornar isso sem configurar um domínio é ligar o HTTPS com certificado
autoassinado que já vem pronto no `app.py`:

```bash
# direto com Python
FLASK_SSL_ADHOC=true python app.py

# ou no .env
echo "FLASK_SSL_ADHOC=true" >> .env
python app.py

# ou no docker-compose.yml, em `environment:`
# - FLASK_SSL_ADHOC=true
```

Isso requer o pacote `pyOpenSSL` (já está no `requirements.txt`). Depois:

1. Descubra o IP da máquina que está rodando o servidor:
   - Windows: `ipconfig` → campo "Endereço IPv4"
   - Linux/macOS: `hostname -I` ou `ip addr`

   Exemplo: `192.168.0.138`.

2. No celular/outro PC (na mesma rede Wi-Fi/LAN), acesse:

   ```
   https://192.168.0.138:5000
   ```

3. O navegador vai avisar que o certificado não é confiável (é
   autoassinado, não emitido por uma autoridade reconhecida) — isso é
   esperado. Clique em "Avançado" → "Continuar assim mesmo" (o texto varia
   por navegador). A conexão continua criptografada; só o aviso de
   confiança do certificado é ignorado.

Depois disso o vault funciona normalmente, porque a página passou a rodar
em `https://`, não em `http://` puro.

## Uso

1. Na primeira vez, crie um nome de usuário + senha mestre — isso fica só no
   seu navegador, nunca é enviado a lugar nenhum.
2. Clique no ícone de contas e cadastre uma ou mais contas Growatt (usuário
   e senha do app, e opcionalmente o ID da usina).
3. O painel atualiza automaticamente; use o ícone de engrenagem para mudar o
   intervalo de atualização.
4. "Sair" bloqueia o vault sem apagar nada; dá pra trocar usuário/senha
   dentro do painel de contas.

## Segurança do vault

As credenciais de cada conta Growatt ficam criptografadas (AES-GCM, chave
derivada via PBKDF2) no `localStorage` do navegador, protegidas por uma
senha mestre que nunca sai do navegador. Isso protege o conteúdo salvo
contra quem tiver acesso ao perfil do navegador sem a senha mestre, mas não
contra alguém que já tenha essa senha ou controle total de uma aba já
desbloqueada — é o mesmo modelo usado por gerenciadores de senha locais. Se
você esquecer a senha mestre, não há recuperação: é preciso resetar o vault
e recadastrar as contas.

## Aviso importante

Este projeto depende da biblioteca
[`growattServer`](https://github.com/indykoning/PyPi_GrowattServer), que
acessa uma API **não-oficial e reversa** da Growatt (o mesmo endpoint usado
pelo app ShinePhone). Isso significa que:

- A Growatt pode mudar ou bloquear esses endpoints sem aviso, quebrando o
  funcionamento deste app.
- Este projeto **não é afiliado, endossado ou suportado pela Growatt**.
- Use por sua conta e risco.

## Licença

Distribuído sob a licença [MIT](LICENSE).
