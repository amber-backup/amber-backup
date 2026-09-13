import type { AgentsMessages } from '../en/agents';

export const agents: AgentsMessages = {
  methods: {
    binary: 'Binary (systemd)',
    docker: 'Docker',
    dockerCompose: 'Docker Compose',
  },
  intro: {
    compose: 'Als docker-compose.yml auf dem Zielserver speichern und anschließend "docker compose up -d" ausführen:',
    run: 'Auf dem Zielserver ausführen:',
    composeValid: (minutes: number) =>
      `Als docker-compose.yml auf dem Zielserver speichern und anschließend "docker compose up -d" ausführen (gültig für ${minutes} Min.):`,
    runValid: (minutes: number) => `Auf dem Zielserver ausführen (gültig für ${minutes} Min.):`,
  },
  page: {
    title: 'Agents',
    subtitle: (online: number, total: number) => `${online} von ${total} online`,
    rollOut: 'Agent ausrollen',
    fleet: 'Serverflotte',
    colHost: 'Host',
    colAgent: 'Agent',
    colLastContact: 'Letzter Kontakt',
    colRestic: 'Restic',
    empty: 'Noch keine Agents. Rollen Sie einen Agent auf einem entfernten Server aus.',
  },
  row: {
    installing: 'wird installiert…',
    never: 'nie',
    remove: 'Agent entfernen',
    removeConfirm: (name: string) =>
      `"${name}" wird entfernt. Der Agent kann sich danach nicht mehr beim Server melden.`,
    removed: 'Agent entfernt',
  },
  rollout: {
    title: 'Agent ausrollen',
    name: 'Agent-Name',
    namePlaceholder: 'z. B. web-01',
    namePlaceholderOptional: 'z. B. web-01 (optional)',
    method: 'Methode',
    enterName: 'Geben Sie einen Agent-Namen ein, um den Befehl zu erhalten.',
    commandCopied: 'Befehl kopiert',
    copyFailed: 'Kopieren fehlgeschlagen — bitte manuell markieren und kopieren',
    generate: 'Token erzeugen',
  },
};
