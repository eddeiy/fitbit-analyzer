import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { MenuItem } from 'primeng/api';
import { Menubar } from 'primeng/menubar';
import { Toast } from 'primeng/toast';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, Menubar, Toast],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly items: MenuItem[] = [
    { label: 'Connect & Sync', icon: 'pi pi-sync', routerLink: '/', routerLinkActiveOptions: { exact: true } },
    { label: 'Data', icon: 'pi pi-table', routerLink: '/data' },
  ];
}
