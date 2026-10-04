import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Check, CreditCard, Loader2, LogOut } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

const PLANS = [
  {
    id: "crew",
    name: "Crew",
    price: "$9",
    cadence: "per month",
    tagline: "For the everyday watcher",
    features: [
      "Full catalog access",
      "Schedule team screenings",
      "Comment on any title",
      "Contribute movies",
    ],
  },
  {
    id: "premiere",
    name: "Premiere",
    price: "$24",
    cadence: "per month",
    tagline: "For the super-fans",
    features: [
      "Everything in Crew",
      "Priority screening rooms",
      "Early access to new releases",
      "Supports catalog hosting costs",
    ],
    featured: true,
  },
];

export default function Checkout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const orders = useQuery(api.orders.listMine);
  const createOrder = useMutation(api.orders.create);
  const [isCheckingOut, setIsCheckingOut] = useState<string | null>(null);

  // Only paid orders count as an active plan.
  const hasPaidPlan = (planId: string) =>
    orders?.some((o) => o.plan === planId && o.status === "paid") ?? false;

  const handleCheckout = async (planId: string) => {
    setIsCheckingOut(planId);
    try {
      await createOrder({ plan: planId });
      const planName = PLANS.find((p) => p.id === planId)?.name ?? planId;
      toast.info(
        `${planName} order placed — pending payment. An admin confirms payment before the plan is active.`,
      );
      navigate("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setIsCheckingOut(null);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label="FilmFlix home">
              <Logo />
            </Link>
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
              Plans
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="gap-2">
              <Link to="/">
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Browse</span>
              </Link>
            </Button>
            {user && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={async () => {
                  await signOut();
                }}
              >
                <LogOut className="size-4" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 pb-24 pt-12 sm:px-6">
        <div className="text-center">
          <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            Pick a plan for the crew
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            FilmFlix is our internal catalog. Plans keep it running and unlock
            extras for everyone on the team.
          </p>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {PLANS.map((plan) => {
            const active = hasPaidPlan(plan.id);
            return (
              <Card
                key={plan.id}
                className={`relative flex flex-col border-border/60 bg-card/70 ${
                  plan.featured ? "border-primary/50 glow-accent" : ""
                }`}
              >
                {plan.featured && (
                  <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground">
                    Most popular
                  </Badge>
                )}
                <CardHeader>
                  <CardTitle className="font-display text-xl">{plan.name}</CardTitle>
                  <CardDescription>{plan.tagline}</CardDescription>
                  <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="font-display text-4xl font-extrabold">{plan.price}</span>
                    <span className="text-sm text-muted-foreground">{plan.cadence}</span>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-4">
                  <ul className="space-y-2.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                        <span className="text-foreground/90">{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="mt-auto w-full gap-2"
                    variant={plan.featured ? "default" : "outline"}
                    disabled={isCheckingOut !== null}
                    onClick={() => handleCheckout(plan.id)}
                  >
                    {isCheckingOut === plan.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CreditCard className="size-4" />
                    )}
                    {active ? "Subscribe again" : `Choose ${plan.name}`}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {orders && orders.length > 0 && (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            You have {orders.length} order{orders.length > 1 ? "s" : ""} on file —
            manage them from your{" "}
            <Link to="/dashboard" className="text-primary underline underline-offset-4">
              library
            </Link>
            .
          </p>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          Orders are recorded as pending until payment is confirmed by an
          admin. Card payments can be connected later.
        </p>
      </main>
    </div>
  );
}
