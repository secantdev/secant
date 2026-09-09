param([Parameter(Mandatory = $true)][string]$Test)
# Run the failing test. Its exit status becomes the Command step's verdict:
# 0 -> pass, anything else -> fail.
node --test $Test
exit $LASTEXITCODE
