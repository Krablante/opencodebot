# WireGuard для приватного браузера

[Русский](wireguard.md) · [English](../en/wireguard.md) · [Указатель](README.md)

WireGuard нужен только для доступа к обычному веб-интерфейсу OpenCodez из другой сети. Telegram long polling, API-зеркало, вложения и браузер в локальной сети работают без него. Серверный helper здесь рассчитан на **Linux** с `wg`, `wg-quick`, `systemd` и `iptables`; клиенты WireGuard есть для Linux, macOS, Windows, Android и iOS.

## Подготовка

Укажите в приватном `config.local.json` свою сеть. Порт UDP должен быть перенаправлен маршрутизатором на Linux-хост WireGuard. Публичный адрес или DNS-имя понадобится для конфигурации клиента. Не открывайте порт backend OpenCodez напрямую в интернет.

```json
{
  "wireguard": {
    "enabled": false,
    "interface": "wg0",
    "listenPort": 51820,
    "serverAddress": "10.77.0.1/24",
    "subnet": "10.77.0.0/24",
    "lanSubnet": "192.168.1.0/24",
    "dns": "192.168.1.1",
    "wanInterface": "eth0",
    "stateDir": "state/wireguard"
  }
}
```

Замените `lanSubnet`, `dns` и `wanInterface` на реальные значения вашего хоста; выберите незанятую сеть WireGuard для `serverAddress`/`subnet`. Helper проверяет корректность IPv4 CIDR, что адрес сервера находится внутри подсети, и выдаёт пирам адреса именно из неё. Поле `enabled` информационное: установка интерфейса происходит по команде, а не вместе с запуском бота.

## Сервер и устройства

```bash
npm run wireguard -- init
npm run wireguard -- peer phone --endpoint home.example.com
```

`init` создаёт серверный ключ под `wireguard.stateDir`, устанавливает конфиг в `/etc/wireguard` и включает `wg-quick@wg0`. `peer` создаёт отдельный ключ и конфиг в `<stateDir>/peers/`, добавляет peer на сервер и перезапускает интерфейс. Если установлен `qrencode`, рядом появляется PNG для мобильного клиента. Устройство должно иметь собственный peer; его `.conf` и QR содержат приватный ключ и не должны попадать в Git или публичные сообщения. Вместо `--endpoint` можно задать `WG_ENDPOINT`.

Включите туннель на клиенте и откройте привычный приватный URL OpenCodez. При отсутствии handshake проверьте перенаправление UDP, адрес endpoint и firewall. При наличии handshake, но без веб-сайта, проверьте `lanSubnet`, интерфейс NAT и доступность OpenCodez с другого устройства той же LAN. Если IP работает, а имя нет, разберите DNS отдельно. На сервере помогают `sudo systemctl status wg-quick@wg0 --no-pager` и `sudo wg show`.

В helper пока нет отдельной команды отзыва. Чтобы отозвать устройство, удалите его запись из приватного `<stateDir>/peers.json`, снова выполните `npm run wireguard -- init` и удалите сохранённые клиентские `.conf`/PNG. Сначала сделайте копию этого приватного состояния; никогда не раздавайте один peer двум устройствам. Отключение WireGuard не должно влиять на Telegram и локальный веб-интерфейс.
