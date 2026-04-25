# pixel-request-chunks frontend

JS client for transport-level request chunking with form snapshots and recovery.

## Install from GitHub

```bash
npm install github:Pixel-Softwares-com/Pixel-Frontend-chunks#v0.3.2
```

## Use

```ts
import { send } from 'pixel-request-chunks';

const formData = new FormData();
formData.append('invoice_id', '123');
formData.append('file', fileInput.files[0]);

const response = await send('/api/invoices', formData, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
  onProgress(sent, total) {
    console.log(Math.round((sent / total) * 100));
  },
});
```

## Axios adapter

```ts
import axios from 'axios';
import { createChunkedAxiosAdapter } from 'pixel-request-chunks';

const api = axios.create({
  baseURL: 'https://api.example.com',
  adapter: createChunkedAxiosAdapter(axios, {
    chunkThresholdBytes: 500 * 1024,
    saveSnapshot: false,
  }),
});
```
