export async function withMongoTransaction(client, work) {
  if (!client) throw new Error('Connessione MongoDB non disponibile');
  if (typeof work !== 'function') throw new Error('Operazione transazionale mancante');
  const session = client.startSession();
  try {
    let output;
    await session.withTransaction(async () => {
      output = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });
    return output;
  } finally {
    await session.endSession();
  }
}
