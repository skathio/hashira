namespace HashiraTestMinVer;

/// <summary>
/// Synthetic fixture class. The dotnet-pack-version smoke job does not
/// execute any code from this assembly — it only verifies that `dotnet
/// pack` produces a .nupkg whose filename embeds the MinVer-resolved
/// version.
/// </summary>
public static class Class1
{
    public static string Greet() => "hello from hashira-ops self-CI fixture";
}
