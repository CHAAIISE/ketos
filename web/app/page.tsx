export default function Home() {
  return (
    <main className="flex flex-1 flex-col justify-center gap-4 px-6 py-24 md:px-16">
      <h1 className="text-4xl font-medium tracking-tight">ketos</h1>
      <p className="max-w-xl text-muted-foreground">
        Perpetual futures on NEAR, with open interest and leverage capped by the exit
        liquidity measured on NEAR Intents.
      </p>
    </main>
  );
}
