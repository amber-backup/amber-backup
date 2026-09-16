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
    edit: 'Edit agent',
    ipRestricted: (n: number) => (n === 1 ? '1 allowed IP' : `${n} allowed IPs`),
  },
  editor: {
    title: 'Edit agent',
    name: 'Name',
    nameRequired: 'Name is required',
    pollInterval: 'Poll interval (seconds)',
    pollIntervalHelp: 'How often the agent asks for new tasks (5–3600).',
    pollIntervalInvalid: 'Poll interval must be a whole number between 5 and 3600',
    labels: 'Labels',
    labelsHelp: 'Comma-separated, e.g. prod, eu-west.',
    allowedIps: 'Allowed IP addresses',
    allowedIpsHelp:
      'One IP address or CIDR range per line. Leave empty to allow any address.',
    lastIp: (ip: string) => `Last contact from ${ip}.`,
    addLastIp: 'Add',
    allowlistWarning:
      'Requests from any other address are rejected — make sure the agent\'s address is covered, or it can no longer check in.',
    saved: 'Agent saved',
    saveFailed: 'Save failed',
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
