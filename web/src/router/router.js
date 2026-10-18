import { createRouter, createWebHistory } from 'vue-router';
import IndexPage from '../views/IndexPage.vue';
import ParsePage from '../views/ParsePage.vue';
import BatchPage from '../views/BatchPage.vue';
import FilePage from '../views/FilePage.vue';

const routes = [
  { path: '/', name: 'index', component: IndexPage },
  { path: '/parse', name: 'parse', component: ParsePage },
  { path: '/batch', name: 'batch', component: BatchPage },
  { path: '/file', name: 'file', component: FilePage },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});