package sandboxd

import (
	"os"
	"path/filepath"
)

type Config struct {
	RootDir       string
	StateDir      string
	SocketPath    string
	GatewayPort   int
	CommandRunner Runner
}

func DefaultConfig() Config {
	stateDir := valueOrDefault(os.Getenv("SALEOR_SANDBOX_STATE_DIR"), "/var/lib/saleor-sandbox")
	return Config{
		RootDir:       valueOrDefault(os.Getenv("SALEOR_SANDBOX_ROOT"), "/opt/saleor-sandbox"),
		StateDir:      stateDir,
		SocketPath:    valueOrDefault(os.Getenv("SALEOR_SANDBOX_SOCKET"), "/run/saleor-sandbox/sandboxd.sock"),
		GatewayPort:   8080,
		CommandRunner: OSRunner{},
	}
}

func (c Config) StatusPath() string {
	return filepath.Join(c.StateDir, "status.json")
}

func (c Config) ProvisionLogPath() string {
	return filepath.Join(c.StateDir, "provision.log")
}

func (c Config) PlatformDir() string {
	return filepath.Join(c.RootDir, "platform")
}

func (c Config) SaleorDir() string {
	return filepath.Join(c.RootDir, "saleor")
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
