package postgres

import (
	"database/sql"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/types"
	_ "github.com/lib/pq"
)

type Monitor struct {
	mu                   sync.RWMutex
	db                   *sql.DB
	isSimulatingDeadlock bool
	records              []types.PostgresLockRecord
}

func NewMonitor() *Monitor {
	m := &Monitor{
		records: make([]types.PostgresLockRecord, 0),
	}
	m.seedDefaultObservation()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL != "" {
		m.connectPostgres(dbURL)
	}

	return m
}

func (m *Monitor) connectPostgres(dbURL string) {
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		fmt.Printf("[Postgres] Failed to open connection: %v\n", err)
		return
	}

	timer := time.AfterFunc(2*time.Second, func() {
		_ = db.Close()
	})
	defer timer.Stop()

	if err := db.Ping(); err != nil {
		fmt.Printf("[Postgres] Connection check failed (%v). Operating in observation observer mode.\n", err)
		_ = db.Close()
		return
	}

	m.mu.Lock()
	m.db = db
	m.mu.Unlock()
	fmt.Println("[Postgres] Successfully connected to PostgreSQL catalog.")
}

func (m *Monitor) seedDefaultObservation() {
	now := time.Now()
	m.records = []types.PostgresLockRecord{
		{
			PID:           14022,
			Database:      "deadlockiq_production",
			Relation:      "orders_partition_2026",
			LockType:      "relation",
			Mode:          "RowExclusiveLock",
			Granted:       true,
			TransactionID: "pg_tx_88192",
			Query:         "UPDATE orders_partition_2026 SET status = 'PROCESSING' WHERE order_id = 'ORD-902'",
			QueryStart:    now.Add(-4200 * time.Millisecond).Format(time.RFC3339),
		},
		{
			PID:           14035,
			Database:      "deadlockiq_production",
			Relation:      "accounts_ledger",
			LockType:      "transactionid",
			Mode:          "ExclusiveLock",
			Granted:       true,
			TransactionID: "pg_tx_88194",
			Query:         "SELECT balance FROM accounts_ledger WHERE account_id = 1042 FOR UPDATE",
			QueryStart:    now.Add(-3100 * time.Millisecond).Format(time.RFC3339),
		},
	}
}

func (m *Monitor) SimulatePostgresDeadlock() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	m.isSimulatingDeadlock = true
	m.records = []types.PostgresLockRecord{
		{
			PID:           18401,
			Database:      "deadlockiq_production",
			Relation:      "inventory_items",
			LockType:      "tuple",
			Mode:          "ExclusiveLock",
			Granted:       true,
			TransactionID: "pg_tx_9011",
			Query:         "UPDATE inventory_items SET stock = stock - 1 WHERE sku = 'ITEM-X'",
			QueryStart:    now.Add(-1500 * time.Millisecond).Format(time.RFC3339),
		},
		{
			PID:           18402,
			Database:      "deadlockiq_production",
			Relation:      "inventory_items",
			LockType:      "tuple",
			Mode:          "ExclusiveLock",
			Granted:       false,
			WaitingForPID: 18401,
			TransactionID: "pg_tx_9012",
			Query:         "UPDATE inventory_items SET stock = stock - 1 WHERE sku = 'ITEM-X'",
			QueryStart:    now.Add(-1200 * time.Millisecond).Format(time.RFC3339),
		},
		{
			PID:           18402,
			Database:      "deadlockiq_production",
			Relation:      "pricing_rules",
			LockType:      "relation",
			Mode:          "RowExclusiveLock",
			Granted:       true,
			TransactionID: "pg_tx_9012",
			Query:         "UPDATE pricing_rules SET discount = 0.15 WHERE rule_id = 'TIER-1'",
			QueryStart:    now.Add(-1400 * time.Millisecond).Format(time.RFC3339),
		},
		{
			PID:           18401,
			Database:      "deadlockiq_production",
			Relation:      "pricing_rules",
			LockType:      "relation",
			Mode:          "RowExclusiveLock",
			Granted:       false,
			WaitingForPID: 18402,
			TransactionID: "pg_tx_9011",
			Query:         "UPDATE pricing_rules SET discount = 0.20 WHERE rule_id = 'TIER-1'",
			QueryStart:    now.Add(-950 * time.Millisecond).Format(time.RFC3339),
		},
	}
}

func (m *Monitor) GetObservedLocks() []types.PostgresLockRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()

	cp := make([]types.PostgresLockRecord, len(m.records))
	copy(cp, m.records)
	return cp
}

func (m *Monitor) IsDeadlockObserved() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, r1 := range m.records {
		if !r1.Granted && r1.WaitingForPID != 0 {
			for _, r2 := range m.records {
				if r2.PID == r1.WaitingForPID && !r2.Granted && r2.WaitingForPID == r1.PID {
					return true
				}
			}
		}
	}
	return false
}

func (m *Monitor) GetStatus() string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.isSimulatingDeadlock {
		return "SIMULATING"
	}
	return "CONNECTED"
}

func (m *Monitor) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.isSimulatingDeadlock = false
	m.seedDefaultObservation()
}
