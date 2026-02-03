fetch('{{URL}}', JSON.parse('{{OPTIONS_JSON}}')).then(async ({ status, statusText, headers, ...r }) => {
  const body = await r.bytes().then(Object.values);
  return { status, statusText, headers: Object.fromEntries([...headers.entries()]), body };
});
