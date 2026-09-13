export const agents = {
  methods: {
    binary: 'Binary (systemd)',
    docker: 'Docker',
    dockerCompose: 'Docker Compose',
  },
  intro: {
    compose: 'Save as docker-compose.yml on the target server, then run "docker compose up -d":',
    run: 'Run on the target server:',
    composeValid: (minutes: number) =>
      `Save as docker-compose.yml on the target server, then run "docker compose up -d" (valid for ${minutes} min):`,
    runValid: (minutes: number) => `Run on the target server (valid for ${minutes} min):`,
  },
  page: {
    title: 'Agents',
    subtitle: (online: number, total: number) => `${online} of ${total} online`,
    rollOut: 'Roll out agent',
    fleet: 'Server fleet',
    colHost: 'Host',
    colAgent: 'Agent',
    colLastContact: 'Last contact',
    colRestic: 'Restic',
    empty: 'No agents yet. Roll out an agent on a remote server.',
  },
  row: {
    installing: 'installing…',
    never: 'never',
    remove: 'Remove agent',
    removeConfirm: (name: string) => `"${name}" will be removed. The agent will no longer be able to check in.`,
    removed: 'Agent removed',
  },
  rollout: {
    title: 'Roll out agent',
    name: 'Agent name',
    namePlaceholder: 'e.g. web-01',
    namePlaceholderOptional: 'e.g. web-01 (optional)',
    method: 'Method',
    enterName: 'Enter an agent name to get the command.',
    commandCopied: 'Command copied',
    copyFailed: 'Copy failed — select and copy manually',
    generate: 'Generate token',
  },
};

export type AgentsMessages = typeof agents;
