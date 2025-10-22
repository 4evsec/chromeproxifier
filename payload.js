fetch('{{URL}}', JSON.parse('{{OPTIONS_JSON}}')).then(async (response) => {
  const { status, statusText, headers } = response;
  const body = await response.bytes().then(Object.values);
  return { status, statusText, headers: Object.fromEntries([...headers.entries()]), body };
});
