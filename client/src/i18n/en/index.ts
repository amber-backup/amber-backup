import { common } from './common';
import { login } from './login';
import { device } from './device';
import { dashboard } from './dashboard';
import { targets } from './targets';
import { jobs } from './jobs';
import { agents } from './agents';
import { hyperv } from './hyperv';
import { proxmox } from './proxmox';
import { snapshots } from './snapshots';
import { users } from './users';
import { notifications } from './notifications';
import { reports } from './reports';
import { admin } from './admin';
import { audit } from './audit';
import { settings } from './settings';
import { integrity } from './integrity';
import { backendFields } from './backendFields';
import { storageChart } from './storageChart';
import { runs } from './runs';

export const en = {
  common,
  login,
  device,
  dashboard,
  targets,
  jobs,
  agents,
  hyperv,
  proxmox,
  snapshots,
  users,
  notifications,
  reports,
  admin,
  audit,
  settings,
  integrity,
  backendFields,
  storageChart,
  runs,
};

export type Messages = typeof en;
