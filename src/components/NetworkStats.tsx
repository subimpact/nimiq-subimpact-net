import { Card, CardContent } from "@/components/ui/card"

export interface NetworkStat {
  label: string
  value: string
  sub?: string
}

export function NetworkStats({ stats }: { stats: NetworkStat[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label} size="sm">
          <CardContent className="px-4 py-4">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {s.value}
            </p>
            {s.sub && <p className="mt-0.5 text-xs text-muted-foreground">{s.sub}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
