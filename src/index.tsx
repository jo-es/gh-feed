#!/usr/bin/env node
import React, { useCallback, useEffect, useState } from "react";
import { Box, render, Text, useInput, useStdin } from "ink";
import { CommentsViewer, PrSelector } from "./App.js";
import { listOpenPrs, loadPrComments, submitPrComment } from "./gh.js";
import type { CliOptions, LoadedPrComments, PrListItem, SubmitCommentRequest } from "./types.js";

const HELP = `ghr - Read GitHub PR comments in a threaded Ink TUI

Usage:
  ghr
  ghr --pr 123
  ghr --repo owner/repo
  ghr --repo owner/repo --pr 123

Options:
  --pr <number>      Initial PR selection
  --repo <o/r>       Repo override (owner/repo)
  -h, --help         Show help
`;

const CLEAR_TERMINAL = "\u001B[2J\u001B[3J\u001B[H";
const AUTO_REFRESH_INTERVAL_MS = 10_000;

type Screen =
  | "loading-pr-list"
  | "select-pr"
  | "loading-pr-comments"
  | "view-pr-comments"
  | "error";

function parseArgs(argv: string[]): { options: CliOptions; help: boolean } {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      return { options, help: true };
    }

    if (arg === "--pr") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value for --pr");
      }
      options.prNumber = Number.parseInt(next, 10);
      i += 1;
      continue;
    }

    if (arg.startsWith("--pr=")) {
      options.prNumber = Number.parseInt(arg.slice("--pr=".length), 10);
      continue;
    }

    if (arg === "--repo") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value for --repo");
      }
      options.repoOverride = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--repo=")) {
      options.repoOverride = arg.slice("--repo=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.prNumber !== undefined && (!Number.isInteger(options.prNumber) || options.prNumber <= 0)) {
    throw new Error(`Invalid --pr value "${options.prNumber}"`);
  }

  return { options, help: false };
}

function Spinner({ label }: { label: string }): JSX.Element {
  const { isRawModeSupported } = useStdin();
  const frames = ["|", "/", "-", "\\"];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!isRawModeSupported) {
      return () => undefined;
    }

    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % frames.length);
    }, 120);
    return () => clearInterval(timer);
  }, [isRawModeSupported]);

  return <Text>{`${isRawModeSupported ? frames[index] : "-"} ${label}`}</Text>;
}

function ErrorScreen({
  error,
  onExitRequest,
  onRetryRequest
}: {
  error: string;
  onExitRequest: () => void;
  onRetryRequest?: () => void;
}): JSX.Element {
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        onExitRequest();
        return;
      }

      if (input === "r" && onRetryRequest) {
        onRetryRequest();
      }
    },
    { isActive: Boolean(isRawModeSupported) }
  );

  useEffect(() => {
    if (!isRawModeSupported) {
      onExitRequest();
    }
  }, [isRawModeSupported, onExitRequest]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="red">Failed to load pull requests.</Text>
      <Text>{error}</Text>
      <Text dimColor>
        {isRawModeSupported
          ? onRetryRequest
            ? "Press r to retry, or q to quit."
            : "Press q to quit."
          : "Exiting (non-interactive terminal)."}
      </Text>
    </Box>
  );
}

function pickPreferredPrNumber(
  prs: PrListItem[],
  previous: number | null,
  optionPrNumber?: number
): number | null {
  if (previous !== null && prs.some((pr) => pr.number === previous)) {
    return previous;
  }

  if (optionPrNumber !== undefined && prs.some((pr) => pr.number === optionPrNumber)) {
    return optionPrNumber;
  }

  return prs[0]?.number ?? null;
}

function Root({
  options,
  onExitRequest
}: {
  options: CliOptions;
  onExitRequest: () => void;
}): JSX.Element {
  const [screen, setScreen] = useState<Screen>("loading-pr-list");
  const [repoName, setRepoName] = useState(options.repoOverride || "");
  const [openPrs, setOpenPrs] = useState<PrListItem[]>([]);
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(options.prNumber ?? null);
  const [data, setData] = useState<LoadedPrComments | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [selectorError, setSelectorError] = useState<string | null>(null);
  const [isPrListRefreshing, setIsPrListRefreshing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const refreshPrList = useCallback(
    async (mode: "initial" | "background"): Promise<boolean> => {
      setIsPrListRefreshing(true);
      if (mode === "background") {
        setSelectorError(null);
      }

      try {
        const loaded = await listOpenPrs({ repoOverride: options.repoOverride });
        setRepoName(loaded.repo.nameWithOwner);
        setOpenPrs(loaded.prs);
        setSelectedPrNumber((prev) => pickPreferredPrNumber(loaded.prs, prev, options.prNumber));
        setFatalError(null);
        setSelectorError(null);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (mode === "initial") {
          setFatalError(message);
        } else {
          setSelectorError(`Could not refresh PR list: ${message}`);
        }
        return false;
      } finally {
        setIsPrListRefreshing(false);
      }
    },
    [options.prNumber, options.repoOverride]
  );

  useEffect(() => {
    let cancelled = false;
    setScreen("loading-pr-list");
    setData(null);
    setRefreshError(null);
    setLastUpdatedAt(null);
    setIsRefreshing(false);
    setFatalError(null);
    setSelectorError(null);

    const run = async (): Promise<void> => {
      const ok = await refreshPrList("initial");
      if (cancelled) {
        return;
      }
      setScreen(ok ? "select-pr" : "error");
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshPrList]);

  const retryInitialLoad = useCallback((): void => {
    setScreen("loading-pr-list");
    void refreshPrList("initial").then((ok) => {
      setScreen(ok ? "select-pr" : "error");
    });
  }, [refreshPrList]);

  const openSelectedPr = useCallback(
    async (prNumber: number): Promise<void> => {
      setScreen("loading-pr-comments");
      setSelectedPrNumber(prNumber);
      setSelectorError(null);
      setRefreshError(null);
      setLastUpdatedAt(null);
      setIsRefreshing(false);

      try {
        const loaded = await loadPrComments({
          repoOverride: repoName || options.repoOverride,
          prNumber
        });
        setData(loaded);
        setLastUpdatedAt(Date.now());
        setScreen("view-pr-comments");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSelectorError(`Failed to load PR #${prNumber}: ${message}`);
        setScreen("select-pr");
      }
    },
    [options.repoOverride, repoName]
  );

  const submitComment = useCallback(
    async (request: SubmitCommentRequest): Promise<void> => {
      if (!data || selectedPrNumber === null) {
        throw new Error("No pull request is currently open.");
      }

      setIsRefreshing(true);
      try {
        await submitPrComment({
          repo: data.repo,
          prNumber: selectedPrNumber,
          request
        });

        const loaded = await loadPrComments({
          repoOverride: data.repo.nameWithOwner,
          prNumber: selectedPrNumber
        });
        setData(loaded);
        setRefreshError(null);
        setLastUpdatedAt(Date.now());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRefreshError(message);
        throw new Error(message);
      } finally {
        setIsRefreshing(false);
      }
    },
    [data, selectedPrNumber]
  );

  const backToPrSelection = useCallback((): void => {
    setScreen("select-pr");
    setData(null);
    setRefreshError(null);
    setLastUpdatedAt(null);
    setIsRefreshing(false);
    void refreshPrList("background");
  }, [refreshPrList]);

  useEffect(() => {
    if (screen !== "view-pr-comments" || selectedPrNumber === null) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) {
        return;
      }

      inFlight = true;
      if (!cancelled) {
        setIsRefreshing(true);
      }

      void loadPrComments({
        repoOverride: repoName || options.repoOverride,
        prNumber: selectedPrNumber
      })
        .then((loaded) => {
          if (cancelled) {
            return;
          }
          setData(loaded);
          setRefreshError(null);
          setLastUpdatedAt(Date.now());
        })
        .catch((err) => {
          if (cancelled) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          setRefreshError(message);
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) {
            setIsRefreshing(false);
          }
        });
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [options.repoOverride, repoName, screen, selectedPrNumber]);

  if (screen === "loading-pr-list") {
    return (
      <Box paddingX={1}>
        <Spinner label="Loading open pull requests via gh..." />
      </Box>
    );
  }

  if (screen === "error") {
    return (
      <ErrorScreen
        error={fatalError || "Unknown error"}
        onExitRequest={onExitRequest}
        onRetryRequest={retryInitialLoad}
      />
    );
  }

  if (screen === "loading-pr-comments") {
    return (
      <Box paddingX={1}>
        <Spinner
          label={`Loading comments for PR #${selectedPrNumber ?? "?"} via gh...`}
        />
      </Box>
    );
  }

  if (screen === "select-pr") {
    return (
      <PrSelector
        repoName={repoName || options.repoOverride || "(unknown repo)"}
        prs={openPrs}
        preferredPrNumber={selectedPrNumber}
        isRefreshing={isPrListRefreshing}
        error={selectorError}
        onRefresh={() => {
          void refreshPrList("background");
        }}
        onSelect={(prNumber) => {
          void openSelectedPr(prNumber);
        }}
        onExitRequest={onExitRequest}
      />
    );
  }

  if (screen === "view-pr-comments" && data) {
    return (
      <CommentsViewer
        data={data}
        openPrCount={openPrs.length}
        onExitRequest={onExitRequest}
        onBackToPrSelection={backToPrSelection}
        onSubmitComment={submitComment}
        autoRefreshIntervalMs={AUTO_REFRESH_INTERVAL_MS}
        isRefreshing={isRefreshing}
        lastUpdatedAt={lastUpdatedAt}
        refreshError={refreshError}
      />
    );
  }

  return (
    <ErrorScreen
      error="Unexpected application state."
      onExitRequest={onExitRequest}
      onRetryRequest={retryInitialLoad}
    />
  );
}

function main(): void {
  let parsed: { options: CliOptions; help: boolean };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error("");
    console.error(HELP);
    process.exit(1);
    return;
  }

  if (parsed.help) {
    console.log(HELP);
    process.exit(0);
    return;
  }

  let app: ReturnType<typeof render> | undefined;
  let exiting = false;
  const requestExit = (): void => {
    if (exiting) {
      return;
    }

    exiting = true;
    app?.unmount();
    if (process.stdout.isTTY) {
      process.stdout.write(CLEAR_TERMINAL);
    }
  };

  app = render(<Root options={parsed.options} onExitRequest={requestExit} />, {
    exitOnCtrlC: false
  });

  const handleSigint = (): void => {
    requestExit();
  };

  process.on("SIGINT", handleSigint);
  void app.waitUntilExit().finally(() => {
    process.off("SIGINT", handleSigint);
  });
}

main();
