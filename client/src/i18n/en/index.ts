import { common } from './common';
import { login } from './login';
import { device } from './device';
import { dashboard } from './dashboard';
import { targets } from './targets';
import { jobs } from './jobs';
import { agents } from './agents';
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

export const en = {
  common,
  login,
  device,
  dashboard,
  targets,
  jobs,
  agents,
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
};

export type Messages = typeof en;
