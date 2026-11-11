import { defineConfig } from 'vite';
export default defineConfig({root:'apps/studio',build:{outDir:'../../dist/studio',emptyOutDir:true},server:{host:'127.0.0.1',proxy:{'/api':'http://127.0.0.1:4327'}}});
