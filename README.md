# Script Manager

A small web interface for creating, editing, scheduling, and running scripts. Script output is streamed live to the browser using Server-Sent Events (SSE).

## Features

- Create, edit, and delete executable scripts
- Run scripts with command-line arguments
- Stream stdout and stderr live while a script runs
- Configure environment variables per script
- Schedule scripts with cron expressions
- Persist schedules in `.schedules.json`
- Persist script environment variables in `.env.json`
- Login protection with signed session cookies

## Docker Compose Example

Save this as `docker-compose.yml`, then replace the placeholder credentials and adjust the host scripts path if needed:

```yaml
services:
	script-manager:
		image: amritesh22/script_manager:latest
		container_name: script-manager
		restart: unless-stopped
		ports:
			- "5200:5200"
		environment:
			APP_USER: "<APP_USER>"
			APP_PASS: "<APP_PASS>"
			SECRET_KEY: "<SECRET_KEY>"
			SESSION_HOURS: "12"
			SCRIPTS_DIR: "/scripts"
			ALLOW_CREATE: "true"
			ALLOW_DELETE: "true"
			RUN_TIMEOUT: "300"
		volumes:
			- /DATA/scripts:/scripts
		read_only: true
		tmpfs:
			- /tmp
		security_opt:
			- no-new-privileges:true
		cap_drop:
			- ALL
```



## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5200` | HTTP port |
| `APP_USER` | `admin` | Login username |
| `APP_PASS` | `changeme` | Login password |
| `SECRET_KEY` | Random on startup | Secret used to sign sessions |
| `SESSION_HOURS` | `12` | Session lifetime |
| `SCRIPTS_DIR` | `/scripts` | Directory containing scripts and persisted data |
| `ALLOW_CREATE` | `true` | Allow creating or updating scripts |
| `ALLOW_DELETE` | `true` | Allow deleting scripts |
| `RUN_TIMEOUT` | `300` | Maximum runtime in seconds |
| `MAX_OUTPUT_BYTES` | `200000` | Maximum streamed output per run |
| `TRUSTED_IPS` | Empty | Optional comma-separated IPs that bypass login |

## Security Notes

- Use a strong, unique `APP_PASS`.
- Keep `SECRET_KEY` private and persistent. Changing it logs out existing sessions.
- Do not commit real passwords, secret keys, or `.env.json` files.
- The Compose configuration runs the container as a non-root user with a read-only root filesystem.
