package auth

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

// The case seen on a live hub: the account with allowance answered "overloaded"
// and went on a five-minute cooldown, which left only an account whose weekly
// limit was spent. New work must wait for the first, not be sent to the second,
// whose refusal tells the client to come back in two days.
func TestSpentAccountIsNotPickedWhileSiblingCoolsDown(t *testing.T) {
	setPlanRouting(t, nil, nil)
	now := time.Unix(1_800_000_000, 0)
	forgetReadings(t, "codex-spent", "codex-open")
	week := 7 * 24 * time.Hour
	spentReset := now.Add(2 * 24 * time.Hour)
	ObserveQuotaWindows("codex-spent", now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 100, ResetAt: spentReset, Period: week},
	})
	ObserveQuotaWindows("codex-open", now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 22, ResetAt: now.Add(5 * 24 * time.Hour), Period: week},
	})
	spent := &Auth{ID: "codex-spent", Provider: "codex"}
	open := &Auth{ID: "codex-open", Provider: "codex"}
	selector := &SoonestResetFirstSelector{now: func() time.Time { return now }}
	pick := func(ctx context.Context, auths ...*Auth) (*Auth, error) {
		return selector.Pick(ctx, "codex", "gpt-6.1-sol", cliproxyexecutor.Options{}, auths)
	}

	cooling := withCoolingCandidates(context.Background(), []coolingCandidate{{auth: open, until: now.Add(5 * time.Minute)}})
	got, err := pick(cooling, spent)
	var cooldown *modelCooldownError
	if got != nil || !errors.As(err, &cooldown) {
		t.Fatalf("pick = %v, %v; want a cooldown error", got, err)
	}
	if cooldown.resetIn != 5*time.Minute {
		t.Fatalf("wait = %v, want the sibling's 5m cooldown", cooldown.resetIn)
	}

	// Mixed-provider picks name no provider in the error.
	if _, err = selector.Pick(cooling, "mixed", "gpt-6.1-sol", cliproxyexecutor.Options{}, []*Auth{spent}); !errors.As(err, &cooldown) || cooldown.provider != "" {
		t.Fatalf("mixed pick error = %v, want a cooldown error without a provider", err)
	}

	// Without a cooling sibling every account really is spent: the provider answers.
	if got, err = pick(context.Background(), spent); err != nil || got != spent {
		t.Fatalf("pick with nothing cooling = %v, %v; want the spent account", got, err)
	}

	// A cooling sibling that is itself spent is no reason to wait.
	ObserveQuotaWindows("codex-open", now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 100, ResetAt: now.Add(5 * 24 * time.Hour), Period: week},
	})
	if got, err = pick(cooling, spent); err != nil || got != spent {
		t.Fatalf("pick with a spent sibling cooling = %v, %v; want the spent account", got, err)
	}
	ObserveQuotaWindows("codex-open", now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 22, ResetAt: now.Add(5 * 24 * time.Hour), Period: week},
	})

	// A cooldown that has already ended is ignored.
	ended := withCoolingCandidates(context.Background(), []coolingCandidate{{auth: open, until: now.Add(-time.Second)}})
	if got, err = pick(ended, spent); err != nil || got != spent {
		t.Fatalf("pick with an ended cooldown = %v, %v; want the spent account", got, err)
	}

	// The wait is never longer than the spent account's own reset.
	long := withCoolingCandidates(context.Background(), []coolingCandidate{{auth: open, until: now.Add(3 * 24 * time.Hour)}})
	if _, err = pick(long, spent); !errors.As(err, &cooldown) || cooldown.resetIn != spentReset.Sub(now) {
		t.Fatalf("wait = %v (%v), want the spent account's reset in %v", cooldown.resetIn, err, spentReset.Sub(now))
	}

	// An account with allowance that is available is still simply picked.
	if got, err = pick(cooling, spent, open); err != nil || got != open {
		t.Fatalf("pick with the open account available = %v, %v; want it", got, err)
	}
}

// End to end through the manager: it is the manager that knows which candidates
// are cooling down, and the selector that knows which are spent.
func TestManagerWaitsForCoolingAccountInsteadOfSpentOne(t *testing.T) {
	setPlanRouting(t, nil, nil)
	ctx := context.Background()
	const model = "cooling-sibling-model"
	manager := NewManager(nil, &SoonestResetFirstSelector{}, nil)
	manager.RegisterExecutor(schedulerProviderTestExecutor{provider: "codex"})
	registerSchedulerModels(t, "codex", model, "cooling-spent", "cooling-open")
	forgetReadings(t, "cooling-spent", "cooling-open")

	spent := &Auth{ID: "cooling-spent", Provider: "codex"}
	open := &Auth{ID: "cooling-open", Provider: "codex"}
	for _, auth := range []*Auth{spent, open} {
		if _, err := manager.Register(ctx, auth); err != nil {
			t.Fatalf("register %s: %v", auth.ID, err)
		}
	}
	now := time.Now()
	week := 7 * 24 * time.Hour
	ObserveQuotaWindows(spent.ID, now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 100, ResetAt: now.Add(2 * 24 * time.Hour), Period: week},
	})
	ObserveQuotaWindows(open.ID, now.Add(-time.Minute), []QuotaWindow{
		{Key: "seven_day", UsedPercent: 22, ResetAt: now.Add(5 * 24 * time.Hour), Period: week},
	})

	// With both available, the account with allowance takes the work.
	got, _, err := manager.pickNext(ctx, "codex", model, cliproxyexecutor.Options{}, nil)
	if err != nil || got == nil || got.ID != open.ID {
		t.Fatalf("pickNext() = %v, %v; want %s", got, err, open.ID)
	}

	// The provider answers "overloaded" on that account, which puts it on a cooldown.
	manager.MarkResult(ctx, Result{
		AuthID:   open.ID,
		Provider: "codex",
		Model:    model,
		Success:  false,
		Error:    &Error{HTTPStatus: http.StatusBadGateway, Message: "server_is_overloaded"},
	})
	current, ok := manager.GetByID(open.ID)
	if !ok {
		t.Fatal("open account vanished")
	}
	if blocked, _, next := isAuthBlockedForModel(current, model, time.Now()); !blocked || !next.After(time.Now()) {
		t.Fatalf("the failed account is not on hold (blocked=%v until %v)", blocked, next)
	}

	got, _, err = manager.pickNext(ctx, "codex", model, cliproxyexecutor.Options{}, nil)
	var cooldown *modelCooldownError
	if got != nil || !errors.As(err, &cooldown) {
		t.Fatalf("pickNext() while the open account cools down = %v, %v; want a cooldown error, not the spent account", got, err)
	}
	if cooldown.resetIn <= 0 || cooldown.resetIn > 24*time.Hour {
		t.Fatalf("wait = %v, want the open account's short cooldown", cooldown.resetIn)
	}

	// The same holds inside one request: after the open account failed, the retry
	// that excludes it must not fall back to the spent account either.
	got, _, err = manager.pickNext(ctx, "codex", model, cliproxyexecutor.Options{}, map[string]struct{}{open.ID: {}})
	if got != nil || !errors.As(err, &cooldown) {
		t.Fatalf("pickNext() retry after the open account failed = %v, %v; want a cooldown error", got, err)
	}
	gotMixed, _, _, errMixed := manager.pickNextMixed(ctx, []string{"codex"}, model, cliproxyexecutor.Options{}, map[string]struct{}{open.ID: {}})
	if gotMixed != nil || !errors.As(errMixed, &cooldown) {
		t.Fatalf("pickNextMixed() retry after the open account failed = %v, %v; want a cooldown error", gotMixed, errMixed)
	}
}
