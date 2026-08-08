Para rodar o monitor automaticamente a cada 30min:

```bash
crontab -e
```

Adicione:
```
*/30 * * * * /home/lucas-modesto/opt/Infra/servicos-ipiranga/servicos-status/scripts/monitor.sh
```

Os logs ficam em `/var/log/services-monitor/`.
