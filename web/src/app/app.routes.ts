import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Connect & Sync - Fitbit Data',
    loadComponent: () => import('./pages/connect-sync/connect-sync').then((m) => m.ConnectSync),
  },
  {
    path: 'data',
    title: 'Data - Fitbit Data',
    loadComponent: () => import('./pages/data-browser/data-browser').then((m) => m.DataBrowser),
  },
  { path: '**', redirectTo: '' },
];
