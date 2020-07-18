const express = require('express');
const app = express();
const port = 3001;

app.use(express.static('public'));
app.listen(port, () => console.log(`Example app listening at http://127.0.0.1:${port}`));